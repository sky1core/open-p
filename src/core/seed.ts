import { randomUUID } from 'node:crypto';
import { createAbortError, isAbortError, throwIfAborted } from './abort.js';
import type {
  AppendSessionHistoryInput,
  AppendSessionHistoryResult,
  Backend,
  BackendProvider,
  NativeSessionReadResult,
  NativeTurnIds,
} from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import { loadExternalSeedIrFile, logicalTurnsFromExternalIr, toSeedWriteTurns, type LogicalSeedTurn } from './seed-ir.js';
import {
  SeedProvenanceStore,
  createInitialProvenanceState,
  externalSourceRefs,
  nativeSourceRefs,
  normalizeNativeReadWithProvenance,
  planSeedAppend,
  withAppendedProvenanceEntries,
  type SeedProvenanceSource,
} from './seed-provenance.js';
import type { SeedCliOptions } from './seed-args.js';
import { SessionLockStore } from './session-lock.js';
import { SessionStateStore } from './session-state.js';

// The bootstrap prompt is part of the approved Session Seeding Contract.
export const SEED_BOOTSTRAP_PROMPT = 'Reply with only: OK';

export interface SeedRunInput {
  readonly options: SeedCliOptions; // options.backend is the registered backend id
  readonly provider: BackendProvider;
  readonly sourceProvider: BackendProvider | null;
  readonly createBackend: () => Backend; // called only in create mode (cli.ts supplies TmuxProvider)
  readonly cwd: string;
  readonly debugLog: string | null;
  readonly signal: AbortSignal;
  readonly forceSignal: AbortSignal;
  readonly killSignal: AbortSignal;
}

export interface SeedResult {
  readonly source: SeedResultSource;
  readonly target: {
    readonly backend: string;
    readonly sessionId: string;
  };
  readonly appendedTurns: number;
  readonly mode: 'create' | 'append';
  readonly status: 'created' | 'updated' | 'noop';
}

export type SeedResultSource =
  | { readonly kind: 'native'; readonly backend: string; readonly sessionId: string }
  | { readonly kind: 'external-ir'; readonly documentDigest: string };

type AppendSessionHistory = (input: AppendSessionHistoryInput) => Promise<AppendSessionHistoryResult>;

interface ResolvedSeedSource {
  readonly output: SeedResultSource;
  readonly turns: readonly LogicalSeedTurn[];
  readonly refs: readonly SeedProvenanceSource[];
}

export async function runSeed(input: SeedRunInput): Promise<SeedResult> {
  const appendSessionHistory = input.provider.appendSessionHistory?.bind(input.provider);
  if (!appendSessionHistory) {
    throw new OpenPError(`backend ${input.provider.id} does not support seeding`, EXIT_CODES.usage);
  }
  if (!input.provider.readNativeSession) {
    throw new OpenPError(`backend ${input.provider.id} cannot read native sessions for seeding`, EXIT_CODES.usage);
  }
  if (isSameNativeAppend(input)) {
    return runSameNativeNoopSeed(input);
  }
  const source = await resolveSeedSource(input);
  return input.options.resume
    ? runAppendSeed(input, appendSessionHistory, source)
    : runCreateSeed(input, appendSessionHistory, source);
}

async function runSameNativeNoopSeed(input: SeedRunInput): Promise<SeedResult> {
  const sessionId = input.options.backendSessionId;
  if (!sessionId || input.options.source.kind !== 'native') {
    throw new OpenPError('resume mode requires a session id', EXIT_CODES.usage);
  }
  await new SessionStateStore(input.cwd).requireCompatible({
    backend: input.provider.id,
    backendSessionId: sessionId,
    cwd: input.cwd,
  });
  return {
    source: {
      kind: 'native',
      backend: input.options.source.backend,
      sessionId: input.options.source.sessionId,
    },
    target: { backend: input.provider.id, sessionId },
    appendedTurns: 0,
    mode: 'append',
    status: 'noop',
  };
}

async function runCreateSeed(
  input: SeedRunInput,
  appendSessionHistory: AppendSessionHistory,
  source: ResolvedSeedSource,
): Promise<SeedResult> {
  const backend = input.createBackend();
  const turnId = randomUUID();
  const provisionalSessionId = randomUUID();

  // The backend's runTurn acquires and releases its own lock on provisionalSessionId, so no outer
  // lock is held here (holding the same id would deadlock into a busy error). Streaming, event-log,
  // and envelope wiring are intentionally omitted — seed bootstrap needs only the turn itself.
  const result = await backend.runTurn(
    { turnId, prompt: SEED_BOOTSTRAP_PROMPT, jsonSchema: null },
    {
      cwd: input.cwd,
      backendSessionId: provisionalSessionId,
      resume: false,
      timeoutMs: input.options.timeoutMs,
      model: input.options.model,
      reasoningEffort: input.options.reasoningEffort,
      permissionMode: null,
      tools: null,
      jsonSchema: null,
      backendArgs: [],
      debugLog: input.debugLog,
      paceIntermediateEvents: false,
      signal: input.signal,
      forceSignal: input.forceSignal,
      killSignal: input.killSignal,
    },
  );

  // A turn that completed while a signal was in flight must not be treated as success.
  if (input.signal.aborted) {
    throw createAbortError();
  }
  const sessionId = result.sessionId ?? null;
  if (!sessionId) {
    throw new OpenPError('backend did not return a session id', EXIT_CODES.protocolViolation);
  }

  // Save state before the append so that, if the append fails, the created session and its state
  // survive and the caller can retry with append mode. The append is a real completed turn already.
  await new SessionStateStore(input.cwd).save({
    backend: input.provider.id,
    backendSessionId: sessionId,
    cwd: input.cwd,
    lastProviderSessionId: null,
    sessionLogPath: await input.provider.resolveSessionLogPath(sessionId, input.cwd),
    lastTurnId: result.turnId,
  });

  const provenanceStore = new SeedProvenanceStore(input.cwd);
  try {
    await withSessionLock(input, sessionId, async () => {
      const bootstrapIds = await readBootstrapNativeIds(input, sessionId);
      await provenanceStore.save(createInitialProvenanceState({
        backend: input.provider.id,
        sessionId,
        bootstrap: bootstrapIds,
      }));
      const written = await appendTurns(input, sessionId, appendSessionHistory, source.turns);
      const current = await provenanceStore.load(input.provider.id, sessionId);
      await provenanceStore.save(withAppendedProvenanceEntries(current, {
        targetBackend: input.provider.id,
        targetSessionId: sessionId,
        bootstrap: bootstrapIds,
        sourceRefs: source.refs,
        written: written.turns,
      }));
    });
  } catch (error) {
    throw augmentCreateAppendError(error, input, sessionId);
  }
  return {
    source: source.output,
    target: { backend: input.provider.id, sessionId },
    appendedTurns: source.turns.length,
    mode: 'create',
    status: 'created',
  };
}

async function runAppendSeed(
  input: SeedRunInput,
  appendSessionHistory: AppendSessionHistory,
  source: ResolvedSeedSource,
): Promise<SeedResult> {
  const sessionId = input.options.backendSessionId;
  if (!sessionId) {
    // The parser guarantees a session id whenever resume is set; this is a defensive guard.
    throw new OpenPError('resume mode requires a session id', EXIT_CODES.usage);
  }
  // Existing openp state is required and must match backend + cwd (absent/mismatch -> exit 20).
  await new SessionStateStore(input.cwd).requireCompatible({
    backend: input.provider.id,
    backendSessionId: sessionId,
    cwd: input.cwd,
  });

  const provenanceStore = new SeedProvenanceStore(input.cwd);
  let appendedTurns = 0;
  const status = await withSessionLock(input, sessionId, async (): Promise<'noop' | 'updated'> => {
    const targetRead = await readNative(input.provider, sessionId, input.cwd, input.signal);
    const targetProvenance = await provenanceStore.load(input.provider.id, sessionId);
    const targetTurns = normalizeNativeReadWithProvenance(targetRead, targetProvenance);
    const plan = planSeedAppend(source.turns, targetTurns);
    if (plan.status === 'noop') {
      return 'noop';
    }
    const offset = targetTurns.length;
    const missingRefs = source.refs.slice(offset);
    const written = await appendTurns(input, sessionId, appendSessionHistory, plan.missing);
    const current = await provenanceStore.load(input.provider.id, sessionId);
    await provenanceStore.save(withAppendedProvenanceEntries(current, {
      targetBackend: input.provider.id,
      targetSessionId: sessionId,
      sourceRefs: missingRefs,
      written: written.turns,
    }));
    appendedTurns = plan.missing.length;
    return 'updated';
  });
  if (status === 'noop') {
    return {
      source: source.output,
      target: { backend: input.provider.id, sessionId },
      appendedTurns: 0,
      mode: 'append',
      status: 'noop',
    };
  }
  return {
    source: source.output,
    target: { backend: input.provider.id, sessionId },
    appendedTurns,
    mode: 'append',
    status: 'updated',
  };
}

function isSameNativeAppend(input: SeedRunInput): boolean {
  return Boolean(input.options.resume && input.options.backendSessionId &&
    input.options.source.kind === 'native' &&
    input.options.source.backend === input.provider.id &&
    input.options.source.sessionId === input.options.backendSessionId);
}

// Serializes against concurrent turns via the same lock namespace the backends use for turns.
// Lock contention surfaces as exit 21; release failure only propagates when there is no primary error.
async function withSessionLock<T>(
  input: SeedRunInput,
  sessionId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lock = await new SessionLockStore(input.cwd).acquire(sessionId);
  let primaryError: unknown = null;
  try {
    throwIfAborted(input.signal);
    return await callback();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      if (primaryError === null) {
        throw releaseError;
      }
    }
  }
}

async function appendTurns(
  input: SeedRunInput,
  sessionId: string,
  appendSessionHistory: AppendSessionHistory,
  turns: readonly LogicalSeedTurn[],
): Promise<AppendSessionHistoryResult> {
  throwIfAborted(input.signal);
  const result = await appendSessionHistory({
    sessionId,
    cwd: input.cwd,
    turns: toSeedWriteTurns(turns),
    signal: input.signal,
  });
  if (result.turns.length !== turns.length) {
    throw new OpenPError('seed writer returned a different number of turns', EXIT_CODES.protocolViolation);
  }
  result.turns.forEach((written, index) => {
    const requested = turns[index]!;
    if (written.logicalId !== requested.logicalId || written.contentDigest !== requested.contentDigest) {
      throw new OpenPError('seed writer changed or reordered logical turns', EXIT_CODES.protocolViolation);
    }
    assertNativeTurnIds(written.nativeIds, 'seed writer');
  });
  return result;
}

async function resolveSeedSource(input: SeedRunInput): Promise<ResolvedSeedSource> {
  if (input.options.source.kind === 'external-ir') {
    const ir = await loadExternalSeedIrFile(input.options.source.path);
    const turns = logicalTurnsFromExternalIr(ir);
    return {
      output: { kind: 'external-ir', documentDigest: ir.documentDigest },
      turns,
      refs: externalSourceRefs(ir.documentDigest, ir.turns.map((turn) => turn.externalId)),
    };
  }
  const provider = input.sourceProvider;
  if (!provider || !provider.readNativeSession) {
    throw new OpenPError(`source backend ${input.options.source.backend} cannot read native sessions`, EXIT_CODES.usage);
  }
  const read = await readNative(provider, input.options.source.sessionId, input.cwd, input.signal);
  const sourceProvenance = await new SeedProvenanceStore(input.cwd).load(provider.id, input.options.source.sessionId);
  const turns = normalizeNativeReadWithProvenance(read, sourceProvenance);
  return {
    output: {
      kind: 'native',
      backend: provider.id,
      sessionId: input.options.source.sessionId,
    },
    turns,
    refs: nativeSourceRefs(provider.id, input.options.source.sessionId, turns),
  };
}

async function readBootstrapNativeIds(input: SeedRunInput, sessionId: string): Promise<readonly NativeTurnIds[]> {
  const read = await readNative(input.provider, sessionId, input.cwd, input.signal);
  if (read.turns.length !== 1) {
    throw new OpenPError('seed bootstrap did not produce exactly one readable native target turn', EXIT_CODES.protocolViolation);
  }
  return [read.turns[0]!.nativeIds];
}

async function readNative(
  provider: BackendProvider,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
): Promise<NativeSessionReadResult> {
  if (!provider.readNativeSession) {
    throw new OpenPError(`backend ${provider.id} cannot read native sessions`, EXIT_CODES.usage);
  }
  const read = await provider.readNativeSession({ sessionId, cwd, signal });
  if (read.backend !== provider.id || read.sessionId !== sessionId) {
    throw new OpenPError('native session reader returned the wrong backend or session id', EXIT_CODES.protocolViolation);
  }
  read.turns.forEach((turn) => {
    if (turn.userText.length === 0 || turn.assistantText.length === 0) {
      throw new OpenPError('native session reader returned an empty logical turn', EXIT_CODES.protocolViolation);
    }
    assertNativeTurnIds(turn.nativeIds, 'native session reader');
  });
  return read;
}

function assertNativeTurnIds(ids: NativeTurnIds, source: string): void {
  if (ids.userId.length === 0 || ids.completionId.length === 0 || ids.assistantIds.length === 0 ||
    ids.assistantIds.some((id) => id.length === 0) || new Set(ids.assistantIds).size !== ids.assistantIds.length ||
    ids.assistantIds.includes(ids.userId)) {
    throw new OpenPError(`${source} returned invalid native turn ids`, EXIT_CODES.protocolViolation);
  }
}

// In create mode the session already exists after bootstrap, so an append failure includes the
// session id and the exact append-mode retry command (stderr is a diagnostics surface). The original
// exit code is preserved; interrupts pass through unchanged.
function augmentCreateAppendError(error: unknown, input: SeedRunInput, sessionId: string): unknown {
  if (isAbortError(error)) {
    return error;
  }
  const retry = input.options.source.kind === 'native'
    ? `openp seed ${input.options.backend} --resume ${sessionId} --source-backend ${input.options.source.backend} --source-session ${input.options.source.sessionId}`
    : 'external IR imports are create-only; rebuild the target session after fixing the error';
  const base = error instanceof Error ? error.message : String(error);
  const message = `${base} (session ${sessionId} was created; ${retry})`;
  if (error instanceof OpenPError) {
    return new OpenPError(message, error.exitCode, error.reasonCode ? { reasonCode: error.reasonCode } : undefined);
  }
  return new OpenPError(message, EXIT_CODES.backendStartFailed);
}
