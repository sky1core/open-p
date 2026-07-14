import { randomUUID } from 'node:crypto';
import { createAbortError, isAbortError, throwIfAborted } from './abort.js';
import type {
  AppendSessionHistoryInput,
  Backend,
  BackendProvider,
  SessionHistoryTurn,
} from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import type { SeedCliOptions } from './seed-args.js';
import { SessionLockStore } from './session-lock.js';
import { SessionStateStore } from './session-state.js';

// Draft-decided constant kept in one place so the still-unapproved wording is cheap to change.
export const SEED_BOOTSTRAP_PROMPT = 'Reply with only: OK';

export interface SeedRunInput {
  readonly options: SeedCliOptions; // options.backend is the registered backend id
  readonly provider: BackendProvider;
  readonly createBackend: () => Backend; // called only in create mode (cli.ts injects TmuxProvider)
  readonly cwd: string;
  readonly turns: readonly SessionHistoryTurn[];
  readonly debugLog: string | null;
  readonly signal: AbortSignal;
  readonly forceSignal: AbortSignal;
  readonly killSignal: AbortSignal;
}

export interface SeedResult {
  readonly backend: string;
  readonly sessionId: string;
  readonly appendedTurns: number;
  readonly mode: 'create' | 'append';
}

type AppendSessionHistory = (input: AppendSessionHistoryInput) => Promise<void>;

export async function runSeed(input: SeedRunInput): Promise<SeedResult> {
  // Fail closed before spending any bootstrap/lock cost: absence of the capability means the backend
  // (opencode) does not support seeding.
  const appendSessionHistory = input.provider.appendSessionHistory?.bind(input.provider);
  if (!appendSessionHistory) {
    throw new OpenPError(`backend ${input.provider.id} does not support seeding`, EXIT_CODES.usage);
  }
  return input.options.resume
    ? runAppendSeed(input, appendSessionHistory)
    : runCreateSeed(input, appendSessionHistory);
}

async function runCreateSeed(input: SeedRunInput, appendSessionHistory: AppendSessionHistory): Promise<SeedResult> {
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

  try {
    await appendTurnsUnderLock(input, sessionId, appendSessionHistory);
  } catch (error) {
    throw augmentCreateAppendError(error, input, sessionId);
  }
  return { backend: input.provider.id, sessionId, appendedTurns: input.turns.length, mode: 'create' };
}

async function runAppendSeed(input: SeedRunInput, appendSessionHistory: AppendSessionHistory): Promise<SeedResult> {
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
  // Append mode does not update openp state: lastTurnId keeps its "id of the last executed turn"
  // meaning, and a seed append is not a turn.
  await appendTurnsUnderLock(input, sessionId, appendSessionHistory);
  return { backend: input.provider.id, sessionId, appendedTurns: input.turns.length, mode: 'append' };
}

// Serializes against concurrent turns via the same lock namespace the backends use for turns.
// Lock contention surfaces as exit 21; release failure only propagates when there is no primary error.
async function appendTurnsUnderLock(
  input: SeedRunInput,
  sessionId: string,
  appendSessionHistory: AppendSessionHistory,
): Promise<void> {
  const lock = await new SessionLockStore(input.cwd).acquire(sessionId);
  let primaryError: unknown = null;
  try {
    throwIfAborted(input.signal);
    await appendSessionHistory({ sessionId, cwd: input.cwd, turns: input.turns, signal: input.signal });
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

// In create mode the session already exists after bootstrap, so an append failure includes the
// session id and the exact append-mode retry command (stderr is a diagnostics surface). The original
// exit code is preserved; interrupts pass through unchanged.
function augmentCreateAppendError(error: unknown, input: SeedRunInput, sessionId: string): unknown {
  if (isAbortError(error)) {
    return error;
  }
  const retry = `openp seed ${input.options.backend} --resume ${sessionId} --history ${input.options.historyPath}`;
  const base = error instanceof Error ? error.message : String(error);
  const message = `${base} (session ${sessionId} was created; retry the history append with: ${retry})`;
  if (error instanceof OpenPError) {
    return new OpenPError(message, error.exitCode, error.reasonCode ? { reasonCode: error.reasonCode } : undefined);
  }
  return new OpenPError(message, EXIT_CODES.backendStartFailed);
}
