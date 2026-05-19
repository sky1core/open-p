import type { BackendProvider, Backend, BackendWorkerBridge } from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { CLAUDE_CODE_DESCRIPTOR } from './descriptor.js';
import { ClaudeCodeBackend } from './adapter.js';
import { ClaudeCodeStdioWorkerBridge } from './stdio-worker-bridge.js';
import { findClaudeCodeSessionLog } from './session-log.js';

export const claudeCodeBackendProvider: BackendProvider = {
  id: 'claude-code',
  aliases: ['claude'],
  descriptor: CLAUDE_CODE_DESCRIPTOR,

  createBackend(provider: PtyProvider): Backend {
    return new ClaudeCodeBackend(provider);
  },

  createWorkerBridge(): BackendWorkerBridge {
    return new ClaudeCodeStdioWorkerBridge();
  },

  async resolveSessionLogPath(sessionId: string, cwd: string): Promise<string | null> {
    return findClaudeCodeSessionLog(sessionId, cwd);
  },
};
