import type { BackendProvider, Backend, BackendWorkerBridge } from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { CLAUDE_CODE_DESCRIPTOR } from './descriptor.js';
import { ClaudeCodeBackend } from './adapter.js';
import { ClaudeCodeWorkerBridge } from './worker-bridge.js';
import { findClaudeCodeSessionLog } from './session-log.js';

export interface ClaudeBackendProviderOptions {
  readonly id?: string;
  readonly configDir?: string | null;
}

export function createClaudeBackendProvider(options: ClaudeBackendProviderOptions = {}): BackendProvider {
  const id = options.id ?? 'claude';
  const configDir = options.configDir ?? null;
  const descriptor = id === CLAUDE_CODE_DESCRIPTOR.id
    ? CLAUDE_CODE_DESCRIPTOR
    : {
        ...CLAUDE_CODE_DESCRIPTOR,
        id,
        label: id,
      };

  return {
    id,
    descriptor,

    createBackend(provider: PtyProvider): Backend {
      return new ClaudeCodeBackend(provider, {
        backendId: id,
        configDir,
      });
    },

    createWorkerBridge(): BackendWorkerBridge {
      return new ClaudeCodeWorkerBridge(undefined, undefined, undefined, {
        backendId: id,
        configDir,
      });
    },

    async resolveSessionLogPath(sessionId: string, cwd: string): Promise<string | null> {
      return findClaudeCodeSessionLog(sessionId, cwd, configDir);
    },
  };
}

export const claudeBackendProvider: BackendProvider = createClaudeBackendProvider();
