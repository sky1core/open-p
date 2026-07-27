import { randomUUID } from 'node:crypto';
import { createAbortError, isAbortError, throwIfAborted } from './abort.js';
import type {
  AppendSessionHistoryInput,
  AppendSessionHistoryResult,
  Backend,
  BackendProvider,
  NativeSessionReadResult,
  NativeSessionTurn,
  NativeTurnIds,
  NativeWrittenTurn,
  PreparedSessionHistoryAppend,
  SeedWriteTurn,
} from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import { assertNativeAppendCandidate } from './native-append-preflight.js';
import { isNativeStateDigest } from './native-state-digest.js';
import { isCanonicalUuidV4 } from './uuid.js';
import {
  SeedAppendJournalStore,
  createSeedAppendJournal,
  provenanceStructureDigest,
  settlePendingSeedAppend,
} from './seed-append-journal.js';
import { canonicalJson } from './seed-append-journal-schema.js';
import { contentDigest, loadExternalSeedIrFile, logicalTurnsFromExternalIr, toSeedWriteTurns, type LogicalSeedTurn } from './seed-ir.js';
import {
  SeedProvenanceStore,
  createInitialProvenanceState,
  externalSourceRefs,
  nativeSourceRefs,
  normalizeNativeReadWithProvenance,
  planSeedAppend,
  withAppendedProvenanceEntries,
  type SeedProvenanceSource,
  type SeedProvenanceState,
} from './seed-provenance.js';
import {
  SeedOperationLockStore,
  SeedOperationReceiptStore,
  assertSeedOperationBinding,
  assertSeedOperationRequest,
  assertSeedOperationSourcePrefix,
  createPreparedSeedOperationReceipt,
  createSeedOperationSourceSnapshot,
  createSeedOperationTargetEvidence,
  nextSeedOperationPhase,
  seedOperationRequestFromSource,
  seedOperationRequestMatchesOptions,
  type SeedOperationBinding,
  type SeedOperationReceipt,
  type SeedOperationReceiptV2,
} from './seed-operation-receipt.js';
import type { SeedCliOptions } from './seed-args.js';
import { SEED_STORAGE_IDENTITY_SCHEME } from './seed-storage-identity.js';
import { SessionLockStore } from './session-lock.js';
import { SessionStateStore, type PendingSeedAppendSessionState } from './session-state.js';
import { createSeedOperationDomainDigest, resolveOpenPStateRoot } from './state-root.js';

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

export interface ResolvedSeedSource {
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
  if (input.options.operationId !== undefined) {
    if (input.options.resume) {
      throw new OpenPError('--operation-id applies only when creating a session, not with --resume', EXIT_CODES.usage);
    }
    return runCreateSeedWithOperation(input, appendSessionHistory);
  }
  const source = await resolveSeedSource(input);
  assertSeedSourceHasPortableTurns(source.turns);
  return input.options.resume
    ? runAppendSeed(input, appendSessionHistory, source)
    : runCreateSeed(input, appendSessionHistory, source);
}

async function runCreateSeedWithOperation(
  input: SeedRunInput,
  appendSessionHistory: AppendSessionHistory,
): Promise<SeedResult> {
  const operationId = input.options.operationId;
  if (!operationId) {
    throw new OpenPError('seed operation id is required', EXIT_CODES.usage);
  }
  const operationStateRoot = resolveOpenPStateRoot(input.cwd);
  const operationLock = await new SeedOperationLockStore(input.cwd, operationStateRoot).acquire(operationId);
  let primaryError: unknown = null;
  try {
    const store = new SeedOperationReceiptStore(input.cwd, operationStateRoot);
    const existing = await store.load(operationId);
    if (existing && !seedOperationRequestMatchesOptions(existing.request, input.options, input.cwd)) {
      throw new OpenPError('seed operation id conflicts with a different semantic request', EXIT_CODES.sessionState, {
        details: { conflict: true },
      });
    }
    if (existing?.schemaVersion === 1) {
      if (existing.phase === 'creating') {
        const indeterminate = nextSeedOperationPhase(existing, 'indeterminate', {
          indeterminateReason: 'creating-owner-ended-before-target-id',
        });
        await store.update(existing, indeterminate);
        throw indeterminateSeedOperationError();
      }
      throw legacySeedOperationError();
    }
    const binding = await resolveSeedOperationBinding(input, operationStateRoot);
    if (existing) {
      assertSeedOperationBinding(existing, binding);
    }
    if (existing?.phase === 'succeeded' &&
      existing.request.source.kind === 'native') {
      return await recoverSucceededSeedOperation(input, existing);
    }
    if (existing?.phase === 'creating') {
      const indeterminate = nextSeedOperationPhase(existing, 'indeterminate', {
        indeterminateReason: 'creating-owner-ended-before-target-id',
      });
      await store.update(existing, indeterminate);
      throw indeterminateSeedOperationError();
    }
    if (existing?.phase === 'indeterminate') {
      throw indeterminateSeedOperationError();
    }
    const resolvedSource = await resolveSeedSource(input);
    assertSeedSourceHasPortableTurns(resolvedSource.turns);
    const request = seedOperationRequestFromSource(input.options, input.cwd, resolvedSource);
    const sourceSnapshot = createSeedOperationSourceSnapshot(resolvedSource);
    let receipt: SeedOperationReceiptV2;
    let source = resolvedSource;
    if (!existing) {
      receipt = createPreparedSeedOperationReceipt({ operationId, request, source: sourceSnapshot, binding });
      await store.create(receipt);
    } else {
      assertSeedOperationRequest(existing, request);
      source = assertSeedOperationSourcePrefix(existing, resolvedSource);
      receipt = existing;
    }

    switch (receipt.phase) {
      case 'prepared':
        return await createSeedFromPreparedOperation(input, appendSessionHistory, source, store, receipt);
      case 'target-created':
        return await recoverTargetCreatedSeedOperation(input, appendSessionHistory, source, store, receipt);
      case 'succeeded':
        return await recoverSucceededSeedOperation(input, receipt);
      case 'creating':
      case 'indeterminate':
        throw indeterminateSeedOperationError();
    }
    throw new OpenPError('seed operation receipt has an unsupported phase', EXIT_CODES.sessionState);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await operationLock.release();
    } catch (releaseError) {
      if (primaryError === null) {
        throw releaseError;
      }
    }
  }
}

async function resolveSeedOperationBinding(
  input: SeedRunInput,
  operationStateRoot: string,
): Promise<SeedOperationBinding> {
  const targetDigest = await resolveProviderSeedStorageIdentity(input.provider, input.cwd);
  let source: SeedOperationBinding['source'];
  if (input.options.source.kind === 'native') {
    const sourceProvider = input.sourceProvider;
    if (!sourceProvider || sourceProvider.id !== input.options.source.backend) {
      throw new OpenPError(
        `source backend ${input.options.source.backend} cannot bind operation storage identity`,
        EXIT_CODES.usage,
      );
    }
    source = {
      kind: 'native',
      storageIdentityDigest: await resolveProviderSeedStorageIdentity(sourceProvider, input.cwd),
    };
  } else {
    source = { kind: 'external-ir' };
  }
  return {
    schemaVersion: 1,
    operationDomainDigest: createSeedOperationDomainDigest(input.cwd, operationStateRoot),
    source,
    target: { storageIdentityDigest: targetDigest },
  };
}

async function resolveProviderSeedStorageIdentity(provider: BackendProvider, cwd: string): Promise<string> {
  const resolveIdentity = provider.resolveSeedStorageIdentity?.bind(provider);
  if (!resolveIdentity) {
    throw new OpenPError(
      `backend ${provider.id} does not support operation identity binding`,
      EXIT_CODES.usage,
    );
  }
  const identity = await resolveIdentity({ cwd });
  if (identity.scheme !== SEED_STORAGE_IDENTITY_SCHEME || !isNativeStateDigest(identity.digest)) {
    throw new OpenPError(
      `backend ${provider.id} returned an invalid operation storage identity`,
      EXIT_CODES.protocolViolation,
    );
  }
  return identity.digest;
}

async function recoverSucceededSeedOperation(
  _input: SeedRunInput,
  receipt: SeedOperationReceipt,
): Promise<SeedResult> {
  const result = receipt.result;
  if (!receipt.target || !result) {
    throw new OpenPError('succeeded seed operation receipt is incomplete', EXIT_CODES.sessionState);
  }
  return result;
}

function indeterminateSeedOperationError(): OpenPError {
  return new OpenPError(
    'seed operation is indeterminate after a prior creating phase; target session id cannot be recovered',
    EXIT_CODES.sessionState,
  );
}

function legacySeedOperationError(): OpenPError {
  return new OpenPError(
    'legacy seed operation receipt lacks execution identity evidence; refusing automatic replay',
    EXIT_CODES.sessionState,
    { details: { conflict: true, identityEvidence: 'legacy-unbound' } },
  );
}

async function runSameNativeNoopSeed(input: SeedRunInput): Promise<SeedResult> {
  const sessionId = input.options.backendSessionId;
  if (!sessionId || input.options.source.kind !== 'native') {
    throw new OpenPError('resume mode requires a session id', EXIT_CODES.usage);
  }
  const stateStore = new SessionStateStore(input.cwd);
  await stateStore.requireCompatibleForPendingSeedSettlement({
    backend: input.provider.id,
    backendSessionId: sessionId,
    cwd: input.cwd,
  });
  await withSessionLock(input, sessionId, async () => {
    await settleProviderPending(input.provider, sessionId, input.cwd, input.signal);
    await stateStore.requireCompatible({
      backend: input.provider.id,
      backendSessionId: sessionId,
      cwd: input.cwd,
    });
    const read = await readNative(input.provider, sessionId, input.cwd, input.signal);
    const provenance = await new SeedProvenanceStore(input.cwd).load(input.provider.id, sessionId);
    assertSeedSourceHasPortableTurns(normalizeNativeReadWithProvenance(read, provenance));
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
  const sessionId = await bootstrapSeedTarget(input);
  const provenanceStore = new SeedProvenanceStore(input.cwd);
  try {
    await withSessionLock(input, sessionId, async () => {
      const { bootstrapRead, bootstrapIds, initialProvenance } =
        await saveInitialTargetProvenance(input, sessionId, provenanceStore);
      await appendTurns({
        input,
        sessionId,
        appendSessionHistory,
        turns: source.turns,
        sourceRefs: source.refs,
        before: bootstrapRead,
        provenance: initialProvenance,
        bootstrap: bootstrapIds,
      });
    });
  } catch (error) {
    throw augmentCreateAppendFailure(error, input, sessionId);
  }
  return {
    source: source.output,
    target: { backend: input.provider.id, sessionId },
    appendedTurns: source.turns.length,
    mode: 'create',
    status: 'created',
  };
}

async function createSeedFromPreparedOperation(
  input: SeedRunInput,
  appendSessionHistory: AppendSessionHistory,
  source: ResolvedSeedSource,
  operationStore: SeedOperationReceiptStore,
  preparedReceipt: SeedOperationReceiptV2,
): Promise<SeedResult> {
  const creatingReceipt = nextSeedOperationPhase(preparedReceipt, 'creating');
  await operationStore.update(preparedReceipt, creatingReceipt);
  const sessionId = await bootstrapSeedTarget(input);
  return finishOperationCreateOnTarget({
    input,
    appendSessionHistory,
    source,
    operationStore,
    receipt: creatingReceipt,
    sessionId,
  });
}

async function recoverTargetCreatedSeedOperation(
  input: SeedRunInput,
  appendSessionHistory: AppendSessionHistory,
  source: ResolvedSeedSource,
  operationStore: SeedOperationReceiptStore,
  receipt: SeedOperationReceiptV2,
): Promise<SeedResult> {
  const target = receipt.target;
  if (!target) {
    throw new OpenPError('seed operation target receipt is missing', EXIT_CODES.sessionState);
  }
  return finishOperationCreateOnTarget({
    input,
    appendSessionHistory,
    source,
    operationStore,
    receipt,
    sessionId: target.sessionId,
  });
}

async function finishOperationCreateOnTarget(input: {
  readonly input: SeedRunInput;
  readonly appendSessionHistory: AppendSessionHistory;
  readonly source: ResolvedSeedSource;
  readonly operationStore: SeedOperationReceiptStore;
  readonly receipt: SeedOperationReceiptV2;
  readonly sessionId: string;
}): Promise<SeedResult> {
  const { operationStore, source, appendSessionHistory, sessionId } = input;
  const seedInput = input.input;
  const provenanceStore = new SeedProvenanceStore(seedInput.cwd);
  let receipt = input.receipt;
  const result: SeedResult = {
    source: receipt.source.output,
    target: { backend: seedInput.provider.id, sessionId },
    appendedTurns: receipt.source.turnCount,
    mode: 'create',
    status: 'created',
  };
  try {
    await withSessionLock(seedInput, sessionId, async () => {
      await settleProviderPending(seedInput.provider, sessionId, seedInput.cwd, seedInput.signal);
      await new SessionStateStore(seedInput.cwd).requireCompatible({
        backend: seedInput.provider.id,
        backendSessionId: sessionId,
        cwd: seedInput.cwd,
      });
      let targetRead = await readNative(seedInput.provider, sessionId, seedInput.cwd, seedInput.signal, 'settlement');
      let targetProvenance = await provenanceStore.load(seedInput.provider.id, sessionId);
      if (receipt.phase === 'creating') {
        const initial = await saveInitialTargetProvenance(seedInput, sessionId, provenanceStore, targetRead);
        const targetEvidence = createSeedOperationTargetEvidence({
          backend: seedInput.provider.id,
          sessionId,
          bootstrapRead: initial.bootstrapRead,
          provenanceDigest: provenanceStructureDigest(initial.initialProvenance, seedInput.provider.id, sessionId),
        });
        const targetCreated = nextSeedOperationPhase(receipt, 'target-created', { target: targetEvidence });
        await operationStore.update(receipt, targetCreated);
        receipt = targetCreated;
        targetRead = initial.bootstrapRead;
        targetProvenance = initial.initialProvenance;
      } else if (receipt.phase !== 'target-created') {
        throw new OpenPError('seed operation receipt is not recoverable as target-created', EXIT_CODES.sessionState);
      } else {
        assertTargetCreatedReceiptMatches(receipt, targetRead, targetProvenance);
      }

      assertSeedOperationProvenancePrefix(source, targetProvenance);
      const targetTurns = normalizeNativeReadWithProvenance(targetRead, targetProvenance);
      const plan = planSeedOperationCreate(source.turns, targetTurns);
      if (plan.status === 'append') {
        const offset = targetTurns.length;
        await appendTurns({
          input: seedInput,
          sessionId,
          appendSessionHistory,
          turns: plan.missing,
          sourceRefs: source.refs.slice(offset),
          before: targetRead,
          provenance: targetProvenance,
        });
      }
      const succeeded = nextSeedOperationPhase(receipt, 'succeeded', { result });
      await operationStore.update(receipt, succeeded);
      receipt = succeeded;
    });
  } catch (error) {
    throw augmentCreateAppendFailure(error, seedInput, sessionId);
  }
  return result;
}

async function bootstrapSeedTarget(input: SeedRunInput): Promise<string> {
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
      nativePermissionMode: null,
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

  // Save state before the append so the completed bootstrap remains addressable for diagnosis and
  // explicit recovery if native append/provenance settlement fails. A writer failure does not prove
  // that no native mutation happened, so this state does not make an automatic append retry safe.
  await new SessionStateStore(input.cwd).save({
    backend: input.provider.id,
    backendSessionId: sessionId,
    cwd: input.cwd,
    lastProviderSessionId: null,
    sessionLogPath: await input.provider.resolveSessionLogPath(sessionId, input.cwd),
    lastTurnId: result.turnId,
  });

  return sessionId;
}

async function saveInitialTargetProvenance(
  input: SeedRunInput,
  sessionId: string,
  provenanceStore: SeedProvenanceStore,
  existingBootstrapRead?: NativeSessionReadResult,
): Promise<{
  readonly bootstrapRead: NativeSessionReadResult;
  readonly bootstrapIds: readonly NativeTurnIds[];
  readonly initialProvenance: SeedProvenanceState;
}> {
  const bootstrapRead = existingBootstrapRead ?? await readBootstrapNativeSession(input, sessionId);
  if (bootstrapRead.turns.length !== 1) {
    throw new OpenPError('seed bootstrap did not produce exactly one readable native target turn', EXIT_CODES.protocolViolation);
  }
  const bootstrapIds = bootstrapRead.turns.map((turn) => turn.nativeIds);
  const initialProvenance = createInitialProvenanceState({
    backend: input.provider.id,
    sessionId,
    bootstrap: bootstrapIds,
  });
  await provenanceStore.save(initialProvenance);
  return { bootstrapRead, bootstrapIds, initialProvenance };
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
  const stateStore = new SessionStateStore(input.cwd);
  await stateStore.requireCompatibleForPendingSeedSettlement({
    backend: input.provider.id,
    backendSessionId: sessionId,
    cwd: input.cwd,
  });

  const provenanceStore = new SeedProvenanceStore(input.cwd);
  let appendedTurns = 0;
  const status = await withSessionLock(input, sessionId, async (): Promise<'noop' | 'updated'> => {
    await settleProviderPending(input.provider, sessionId, input.cwd, input.signal);
    await stateStore.requireCompatible({
      backend: input.provider.id,
      backendSessionId: sessionId,
      cwd: input.cwd,
    });
    const targetRead = await readNative(input.provider, sessionId, input.cwd, input.signal);
    const targetProvenance = await provenanceStore.load(input.provider.id, sessionId);
    const targetTurns = normalizeNativeReadWithProvenance(targetRead, targetProvenance);
    const plan = planSeedAppend(source.turns, targetTurns);
    if (plan.status === 'noop') {
      return 'noop';
    }
    const offset = targetTurns.length;
    const missingRefs = source.refs.slice(offset);
    await appendTurns({
      input,
      sessionId,
      appendSessionHistory,
      turns: plan.missing,
      sourceRefs: missingRefs,
      before: targetRead,
      provenance: targetProvenance,
    });
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

function assertSeedSourceHasPortableTurns(turns: readonly LogicalSeedTurn[]): void {
  if (turns.length === 0) {
    throw new OpenPError('seed source contains no completed portable turns', EXIT_CODES.protocolViolation);
  }
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

async function appendTurns(parameters: {
  readonly input: SeedRunInput;
  readonly sessionId: string;
  readonly appendSessionHistory: AppendSessionHistory;
  readonly turns: readonly LogicalSeedTurn[];
  readonly sourceRefs: readonly SeedProvenanceSource[];
  readonly before: NativeSessionReadResult;
  readonly provenance: SeedProvenanceState | null;
  readonly bootstrap?: readonly NativeTurnIds[];
}): Promise<void> {
  const { input, sessionId, appendSessionHistory, turns, sourceRefs, before, provenance } = parameters;
  throwIfAborted(input.signal);
  const requested = toSeedWriteTurns(turns);
  const journalStore = new SeedAppendJournalStore(input.cwd);
  const provenanceStore = new SeedProvenanceStore(input.cwd);
  const sessionStateStore = new SessionStateStore(input.cwd);
  const restoreState = await sessionStateStore.requireCompatible({
    backend: input.provider.id,
    backendSessionId: sessionId,
    cwd: input.cwd,
  });
  let prepared: PreparedSessionHistoryAppend | null = null;
  let pendingMarker: PendingSeedAppendSessionState | null = null;
  const result = await appendSessionHistory({
    sessionId,
    cwd: input.cwd,
    turns: requested,
    persistPreparedAppend: async (candidate) => {
      if (prepared !== null) {
        throw new OpenPError('seed writer prepared more than one native append', EXIT_CODES.protocolViolation);
      }
      assertPreparedAppend(input.provider, before, requested, candidate);
      const journal = createSeedAppendJournal({
        backend: input.provider.id,
        sessionId,
        before,
        provenance,
        sourceRefs,
        written: candidate.turns,
        candidateNativeStateDigest: candidate.candidateNativeStateDigest,
        cleanupToken: candidate.cleanupToken ?? null,
      });
      pendingMarker = await sessionStateStore.publishPendingSeedAppendMarker({
        restoreState,
        seedAppendJournal: journal,
      });
      await journalStore.create(journal);
      prepared = candidate;
    },
    signal: input.signal,
  });
  const completedPreparation = prepared as PreparedSessionHistoryAppend | null;
  if (completedPreparation === null) {
    throw new OpenPError('seed writer mutated without a prepared append durability barrier', EXIT_CODES.protocolViolation);
  }
  assertAppendResult(result, sessionId, turns);
  assertSameWrittenTurns(result.turns, completedPreparation.turns);
  if (result.postWriteCleanupFailure && completedPreparation.cleanupToken === undefined) {
    throw new OpenPError(
      'seed writer reported a transient artifact cleanup failure without a recoverable cleanup token',
      EXIT_CODES.protocolViolation,
    );
  }
  const progress = {
    nativeAppendVerified: false,
    provenanceSaved: false,
    journalRetired: false,
  };
  let primaryError: unknown = null;
  try {
    const postWriteRead = await readNative(input.provider, sessionId, input.cwd, input.signal, 'settlement');
    assertNativeAppendCandidate({
      backend: input.provider.id,
      before: before.turns,
      candidate: postWriteRead.turns,
      requested,
      written: result.turns,
    });
    if (postWriteRead.nativeStateDigest !== completedPreparation.candidateNativeStateDigest) {
      throw new OpenPError(
        'seed writer post-write native state differs from its prepared candidate',
        EXIT_CODES.protocolViolation,
      );
    }
    progress.nativeAppendVerified = true;
    assertNoCrossTurnNativeIdOverlap([...before.turns, ...result.turns], 'seed writer');
    const next = withAppendedProvenanceEntries(provenance, {
      targetBackend: input.provider.id,
      targetSessionId: sessionId,
      ...(parameters.bootstrap ? { bootstrap: parameters.bootstrap } : {}),
      sourceRefs,
      written: result.turns,
    });
    await provenanceStore.save(next);
    progress.provenanceSaved = true;
    if (!result.postWriteCleanupFailure) {
      await cleanupPreparedAppend(input.provider, sessionId, input.cwd, completedPreparation, input.signal);
      await journalStore.remove(input.provider.id, sessionId);
      progress.journalRetired = true;
      if (!pendingMarker) {
        throw new OpenPError('seed writer committed without a pending session marker', EXIT_CODES.protocolViolation);
      }
      await sessionStateStore.restorePendingSeedAppendMarker(pendingMarker);
    }
  } catch (error) {
    primaryError = error;
  }
  throwAppendSettlementFailure(result, primaryError, progress);
}

function assertPreparedAppend(
  provider: BackendProvider,
  before: NativeSessionReadResult,
  requested: readonly SeedWriteTurn[],
  prepared: PreparedSessionHistoryAppend,
): void {
  const hasCleanupToken = prepared.cleanupToken !== undefined;
  const hasCleanupCapability = provider.cleanupPreparedSessionHistoryAppend !== undefined;
  if (hasCleanupToken !== hasCleanupCapability ||
    (prepared.cleanupToken !== undefined && !isCanonicalUuidV4(prepared.cleanupToken))) {
    throw new OpenPError(
      `seed writer ${provider.id} prepared an invalid cleanup capability contract`,
      EXIT_CODES.protocolViolation,
    );
  }
  assertNativeAppendCandidate({ backend: provider.id, before: before.turns, candidate: prepared.before, requested: [], written: [] });
  if (!isNativeStateDigest(before.nativeStateDigest) ||
    prepared.beforeNativeStateDigest !== before.nativeStateDigest ||
    !isNativeStateDigest(prepared.candidateNativeStateDigest) ||
    prepared.candidateNativeStateDigest === prepared.beforeNativeStateDigest) {
    throw new OpenPError('seed writer prepared invalid native state evidence', EXIT_CODES.protocolViolation);
  }
  assertAppendResult(
    { sessionId: before.sessionId, turns: prepared.turns },
    before.sessionId,
    requested.map((turn): LogicalSeedTurn => ({
      logicalId: turn.logicalId,
      userText: turn.userText,
      assistantText: turn.assistantText,
      contentDigest: turn.contentDigest,
      nativeIds: turn.sourceNativeIds,
    })),
  );
  assertNoCrossTurnNativeIdOverlap([...before.turns, ...prepared.turns], 'seed writer');
}

async function cleanupPreparedAppend(
  provider: BackendProvider,
  sessionId: string,
  cwd: string,
  prepared: PreparedSessionHistoryAppend,
  signal?: AbortSignal,
): Promise<void> {
  if (prepared.cleanupToken === undefined) {
    return;
  }
  const cleanup = provider.cleanupPreparedSessionHistoryAppend;
  if (!cleanup) {
    throw new OpenPError(
      `backend ${provider.id} cannot clean its prepared native append artifact`,
      EXIT_CODES.protocolViolation,
    );
  }
  try {
    await cleanup.call(provider, {
      sessionId,
      cwd,
      token: prepared.cleanupToken,
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const exitCode = error instanceof OpenPError ? error.exitCode : EXIT_CODES.sessionState;
    throw new OpenPError(
      `backend prepared native append artifact cleanup failed: ${errorMessage(error)}`,
      exitCode,
      {
        reasonCode: error instanceof OpenPError ? error.reasonCode : undefined,
        details: {
          ...(error instanceof OpenPError ? error.details : undefined),
          cleanupFailed: true,
        },
      },
    );
  }
}

function assertSameWrittenTurns(
  actual: readonly NativeWrittenTurn[],
  prepared: readonly NativeWrittenTurn[],
): void {
  if (actual.length !== prepared.length || actual.some((turn, index) => {
    const expected = prepared[index]!;
    return turn.logicalId !== expected.logicalId || turn.contentDigest !== expected.contentDigest ||
      !sameNativeIds(turn.nativeIds, expected.nativeIds);
  })) {
    throw new OpenPError('seed writer returned mappings different from its prepared append', EXIT_CODES.protocolViolation);
  }
}

function assertAppendResult(
  result: AppendSessionHistoryResult,
  sessionId: string,
  turns: readonly LogicalSeedTurn[],
): void {
  if (result.sessionId !== sessionId || result.sessionId.length === 0) {
    throw new OpenPError('seed writer returned a different or empty target session id', EXIT_CODES.protocolViolation);
  }
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
  assertNoCrossTurnNativeIdOverlap(result.turns, 'seed writer');
}

function throwAppendSettlementFailure(
  result: AppendSessionHistoryResult,
  primaryError: unknown,
  progress: {
    readonly nativeAppendVerified: boolean;
    readonly provenanceSaved: boolean;
    readonly journalRetired: boolean;
  },
): void {
  const cleanupFailure = result.postWriteCleanupFailure ?? null;

  if (primaryError !== null && cleanupFailure !== null) {
    if (isAbortError(primaryError)) {
      throw createAbortError(
        `${primaryError.message}; backend transient artifact cleanup also failed: ${cleanupFailure.message}`,
        primaryError.interruptedReasoningContent,
      );
    }
    const exitCode = primaryError instanceof OpenPError ? primaryError.exitCode : EXIT_CODES.sessionState;
    throw new OpenPError(
      `${errorMessage(primaryError)}; backend transient artifact cleanup also failed: ${cleanupFailure.message}`,
      exitCode,
      {
        reasonCode: primaryError instanceof OpenPError ? primaryError.reasonCode : undefined,
        details: {
          ...(primaryError instanceof OpenPError ? primaryError.details : undefined),
          ...cleanupFailure.details,
          nativeAppendCommitted: progress.nativeAppendVerified ? true : 'unknown',
          provenanceSaved: progress.provenanceSaved,
          journalRetired: progress.journalRetired,
          cleanupFailed: true,
        },
      },
    );
  }
  if (primaryError !== null) {
    if (primaryError instanceof OpenPError) {
      throw new OpenPError(primaryError.message, primaryError.exitCode, {
        reasonCode: primaryError.reasonCode,
        details: {
          ...primaryError.details,
          nativeAppendCommitted: progress.nativeAppendVerified ? true : 'unknown',
          provenanceSaved: progress.provenanceSaved,
          journalRetired: progress.journalRetired,
        },
      });
    }
    throw primaryError;
  }
  if (cleanupFailure !== null) {
    throw new OpenPError(
      `native append and provenance were saved, but backend transient artifact cleanup failed: ${cleanupFailure.message}`,
      EXIT_CODES.sessionState,
      {
        details: {
          ...cleanupFailure.details,
          nativeAppendCommitted: true,
          provenanceSaved: true,
          journalRetired: progress.journalRetired,
          cleanupFailed: true,
        },
      },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const source = input.options.source;
  const provider = input.sourceProvider;
  if (!provider || !provider.readNativeSession) {
    throw new OpenPError(`source backend ${source.backend} cannot read native sessions`, EXIT_CODES.usage);
  }
  const { read, sourceProvenance } = await withSessionLock(input, source.sessionId, async () => {
    await settleProviderPending(provider, source.sessionId, input.cwd, input.signal);
    return {
      read: await readNative(provider, source.sessionId, input.cwd, input.signal),
      sourceProvenance: await new SeedProvenanceStore(input.cwd).load(provider.id, source.sessionId),
    };
  });
  const turns = normalizeNativeReadWithProvenance(read, sourceProvenance);
  return {
    output: {
      kind: 'native',
      backend: provider.id,
      sessionId: source.sessionId,
    },
    turns,
    refs: nativeSourceRefs(provider.id, source.sessionId, turns),
  };
}

async function readBootstrapNativeSession(input: SeedRunInput, sessionId: string): Promise<NativeSessionReadResult> {
  const read = await readNative(input.provider, sessionId, input.cwd, input.signal);
  if (read.turns.length !== 1) {
    throw new OpenPError('seed bootstrap did not produce exactly one readable native target turn', EXIT_CODES.protocolViolation);
  }
  return read;
}

function assertSeedOperationProvenancePrefix(
  source: ResolvedSeedSource,
  provenance: SeedProvenanceState | null,
): void {
  if (!provenance) {
    throw new OpenPError('seed operation target provenance is missing', EXIT_CODES.sessionState);
  }
  const prefixCount = Math.min(source.turns.length, provenance.entries.length);
  for (let index = 0; index < prefixCount; index += 1) {
    const expectedTurn = source.turns[index]!;
    const expectedSource = source.refs[index]!;
    const entry = provenance.entries[index]!;
    if (entry.logicalId !== expectedTurn.logicalId || entry.contentDigest !== expectedTurn.contentDigest ||
      canonicalJson(entry.source) !== canonicalJson(expectedSource)) {
      throw new OpenPError('seed operation target provenance differs from the recorded source', EXIT_CODES.protocolViolation);
    }
  }
}

function planSeedOperationCreate(
  sourceTurns: readonly LogicalSeedTurn[],
  targetTurns: readonly LogicalSeedTurn[],
): { readonly status: 'noop'; readonly missing: readonly LogicalSeedTurn[] }
  | { readonly status: 'append'; readonly missing: readonly LogicalSeedTurn[] } {
  const sharedCount = Math.min(sourceTurns.length, targetTurns.length);
  for (let index = 0; index < sharedCount; index += 1) {
    if (sourceTurns[index]!.logicalId !== targetTurns[index]!.logicalId ||
      sourceTurns[index]!.contentDigest !== targetTurns[index]!.contentDigest) {
      throw new OpenPError('seed target diverges from source logical turn sequence', EXIT_CODES.protocolViolation);
    }
  }
  if (targetTurns.length >= sourceTurns.length) {
    return { status: 'noop', missing: [] };
  }
  return { status: 'append', missing: sourceTurns.slice(targetTurns.length) };
}

function assertTargetCreatedReceiptMatches(
  receipt: SeedOperationReceipt,
  read: NativeSessionReadResult,
  provenance: SeedProvenanceState | null,
): void {
  const target = receipt.target;
  if (!target) {
    throw new OpenPError('seed operation target receipt is missing', EXIT_CODES.sessionState);
  }
  if (target.backend !== read.backend || target.sessionId !== read.sessionId) {
    throw new OpenPError('seed operation target receipt belongs to a different session', EXIT_CODES.sessionState);
  }
  if (!provenance) {
    throw new OpenPError('seed operation target provenance is missing', EXIT_CODES.sessionState);
  }
  if (provenance.backend !== target.backend || provenance.sessionId !== target.sessionId ||
    provenance.bootstrap.length !== target.bootstrap.length ||
    provenance.bootstrap.some((ids, index) => !sameNativeIds(ids, target.bootstrap[index]!.nativeIds))) {
    throw new OpenPError('seed operation target provenance differs from receipt', EXIT_CODES.sessionState);
  }
  const initialDigest = provenanceStructureDigest({ ...provenance, entries: [] }, target.backend, target.sessionId);
  if (initialDigest !== target.provenanceDigest) {
    throw new OpenPError('seed operation target initial provenance digest differs from receipt', EXIT_CODES.sessionState);
  }
  const bootstrap = read.turns.find((turn) => sameNativeIds(turn.nativeIds, target.bootstrap[0]!.nativeIds));
  if (!bootstrap) {
    throw new OpenPError('seed operation target bootstrap is missing', EXIT_CODES.protocolViolation);
  }
  if (contentDigest(bootstrap.userText, bootstrap.assistantText) !== target.bootstrap[0]!.contentDigest) {
    throw new OpenPError('seed operation target bootstrap content differs from receipt', EXIT_CODES.protocolViolation);
  }
  if (provenance.entries.length === 0 && read.nativeStateDigest !== target.nativeStateDigest) {
    throw new OpenPError('seed operation target bootstrap native state differs from receipt', EXIT_CODES.protocolViolation);
  }
  if (provenance.entries.length < receipt.source.turnCount &&
    read.turns.length !== provenance.bootstrap.length + provenance.entries.length) {
    throw new OpenPError('seed operation target contains unowned native turns', EXIT_CODES.protocolViolation);
  }
}

// Callers must already hold the canonical session lock. Backends and the stream-json runner reuse
// this function before ordinary resumed turns so a committed seed suffix cannot be used before its
// provenance settlement finishes.
export async function settleProviderPending(
  provider: BackendProvider,
  sessionId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!provider.readNativeSession) {
    return;
  }
  await settlePendingSeedAppend({
    backend: provider.id,
    sessionId,
    cwd,
    signal,
    readNativeSession: provider.readNativeSession.bind(provider),
    ...(provider.cleanupPreparedSessionHistoryAppend
      ? { cleanupPreparedAppend: provider.cleanupPreparedSessionHistoryAppend.bind(provider) }
      : {}),
  });
}

async function readNative(
  provider: BackendProvider,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
  mode: 'logical' | 'settlement' = 'logical',
): Promise<NativeSessionReadResult> {
  if (!provider.readNativeSession) {
    throw new OpenPError(`backend ${provider.id} cannot read native sessions`, EXIT_CODES.usage);
  }
  const read = await provider.readNativeSession({ sessionId, cwd, signal, mode });
  if (read.backend !== provider.id || read.sessionId !== sessionId) {
    throw new OpenPError('native session reader returned the wrong backend or session id', EXIT_CODES.protocolViolation);
  }
  if (!isNativeStateDigest(read.nativeStateDigest)) {
    throw new OpenPError('native session reader did not prove complete native state', EXIT_CODES.protocolViolation);
  }
  read.turns.forEach((turn) => {
    if (turn.userText.length === 0 || turn.assistantText.length === 0) {
      throw new OpenPError('native session reader returned an empty logical turn', EXIT_CODES.protocolViolation);
    }
    assertNativeTurnIds(turn.nativeIds, 'native session reader');
  });
  assertNoCrossTurnNativeIdOverlap(read.turns, 'native session reader');
  return read;
}

function assertNativeTurnIds(ids: NativeTurnIds, source: string): void {
  if (ids.userId.length === 0 || ids.completionId.length === 0 || ids.assistantIds.length === 0 ||
    ids.assistantIds.some((id) => id.length === 0) || new Set(ids.assistantIds).size !== ids.assistantIds.length ||
    ids.assistantIds.includes(ids.userId) || ids.completionId === ids.userId) {
    throw new OpenPError(`${source} returned invalid native turn ids`, EXIT_CODES.protocolViolation);
  }
}

function assertNoCrossTurnNativeIdOverlap(
  turns: readonly { readonly nativeIds: NativeTurnIds }[],
  source: string,
): void {
  const seen = new Set<string>();
  for (const turn of turns) {
    const turnIds = new Set([turn.nativeIds.userId, turn.nativeIds.completionId, ...turn.nativeIds.assistantIds]);
    for (const id of turnIds) {
      if (seen.has(id)) {
        throw new OpenPError(`${source} reused a native id across logical turns`, EXIT_CODES.protocolViolation);
      }
    }
    for (const id of turnIds) {
      seen.add(id);
    }
  }
}

function sameNativeIds(a: NativeTurnIds, b: NativeTurnIds): boolean {
  return a.userId === b.userId && a.completionId === b.completionId &&
    a.assistantIds.length === b.assistantIds.length &&
    a.assistantIds.every((id, index) => id === b.assistantIds[index]);
}

// A backend-neutral writer rejection does not prove that no native mutation happened (OpenCode uses
// an import/upsert API). Report the created session for diagnosis, but never present an automatic
// retry command as safe. The original exit code and structured diagnostics are preserved; interrupts
// pass through unchanged.
function augmentCreateAppendFailure(error: unknown, input: SeedRunInput, sessionId: string): unknown {
  if (isAbortError(error)) {
    return error;
  }
  const provenanceSaved = error instanceof OpenPError && error.details?.provenanceSaved === true;
  const journalRetired = error instanceof OpenPError && error.details?.journalRetired === true;
  const cleanupFailed = error instanceof OpenPError && error.details?.cleanupFailed === true;
  const nativeAppendCommitted = error instanceof OpenPError && error.details?.nativeAppendCommitted === true;
  const recovery = provenanceSaved && cleanupFailed
    ? 'native append and provenance were saved; inspect the reported transient cleanup failure'
    : provenanceSaved && !journalRetired
      ? 'native append and provenance were saved; the retained settlement journal must be reconciled on next access'
      : nativeAppendCommitted
        ? 'native append was verified and settlement evidence was retained; do not repeat the seed write'
        : input.options.source.kind === 'native'
          ? 'native append state may be ambiguous; do not retry it automatically'
          : 'external IR imports are create-only; rebuild the target session after fixing the error';
  const base = error instanceof Error ? error.message : String(error);
  const message = `${base} (session ${sessionId} was created; ${recovery})`;
  if (error instanceof OpenPError) {
    return new OpenPError(message, error.exitCode, {
      reasonCode: error.reasonCode,
      details: error.details,
    });
  }
  return new OpenPError(message, EXIT_CODES.backendStartFailed);
}
