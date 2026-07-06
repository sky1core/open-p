import { appendDebugLog } from '../../core/debug-log.js';
import type { BackendRunActivity } from '../../core/types.js';
import type {
  ClaudeCodeLocalCommandNameMismatchDiagnostic,
  ClaudeCodeSessionLogIdleDiagnostic,
} from './session-log.js';

export function createClaudeSessionLogIdleDebugLogger(input: {
  readonly debugLog: string | null;
  readonly backendId?: string;
  readonly backendSessionId: string;
  readonly nativeSessionId: string | null;
  readonly ptySessionId: string;
  readonly onRunActivity?: (activity: BackendRunActivity) => void;
}): (diagnostic: ClaudeCodeSessionLogIdleDiagnostic) => Promise<void> {
  return async (diagnostic) => {
    const backend = input.backendId ?? 'claude';
    await appendDebugLog(input.debugLog, {
      event: 'claude_session_log_waiting',
      severity: 'info',
      backend,
      backendSessionId: input.backendSessionId,
      nativeSessionId: input.nativeSessionId,
      ptySessionId: input.ptySessionId,
      ...diagnostic,
    }).catch(() => undefined);
    try {
      input.onRunActivity?.({
        kind: 'backend_wait',
        backend,
        backendSessionId: input.backendSessionId,
        nativeSessionId: input.nativeSessionId,
        ptySessionId: input.ptySessionId,
        turnId: diagnostic.turnId,
        stage: diagnostic.stage,
        idleMs: diagnostic.idleMs,
        observedAt: new Date().toISOString(),
        observedLogFile: diagnostic.observedLogFile,
        sawCallerUserTurn: diagnostic.sawCallerUserTurn,
      });
    } catch {
      // Activity reporting is diagnostic-only and must not affect the backend turn.
    }
  };
}

export function createClaudeLocalCommandNameMismatchDebugLogger(input: {
  readonly debugLog: string | null;
  readonly backendId?: string;
  readonly backendSessionId: string;
  readonly nativeSessionId: string | null;
  readonly ptySessionId: string;
}): (diagnostic: ClaudeCodeLocalCommandNameMismatchDiagnostic) => Promise<void> {
  return async (diagnostic) => {
    await appendDebugLog(input.debugLog, {
      event: 'claude_local_command_name_mismatch',
      severity: 'warning',
      backend: input.backendId ?? 'claude',
      backendSessionId: input.backendSessionId,
      nativeSessionId: input.nativeSessionId,
      ptySessionId: input.ptySessionId,
      ...diagnostic,
    }).catch(() => undefined);
  };
}
