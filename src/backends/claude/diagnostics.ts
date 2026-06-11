import { appendDebugLog } from '../../core/debug-log.js';
import type { ClaudeCodeSessionLogIdleDiagnostic } from './session-log.js';

export function createClaudeSessionLogIdleDebugLogger(input: {
  readonly debugLog: string | null;
  readonly backendId?: string;
  readonly backendSessionId: string;
  readonly nativeSessionId: string | null;
  readonly ptySessionId: string;
}): (diagnostic: ClaudeCodeSessionLogIdleDiagnostic) => Promise<void> {
  return async (diagnostic) => {
    await appendDebugLog(input.debugLog, {
      event: 'claude_session_log_waiting',
      severity: 'info',
      backend: input.backendId ?? 'claude',
      backendSessionId: input.backendSessionId,
      nativeSessionId: input.nativeSessionId,
      ptySessionId: input.ptySessionId,
      ...diagnostic,
    }).catch(() => undefined);
  };
}
