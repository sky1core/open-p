import type {
  AppendSessionHistoryInput,
  Backend,
  BackendProvider,
  BackendWorkerBridge,
} from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { CLAUDE_CODE_DESCRIPTOR } from './descriptor.js';
import { ClaudeCodeBackend } from './adapter.js';
import { ClaudeCodeWorkerBridge } from './worker-bridge.js';
import { appendClaudeCodeSessionHistory } from './history-writer.js';
import { findClaudeCodeSessionLog } from './session-log.js';
import { probeClaudeCodeLogin } from './login.js';

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

    async probeLogin() {
      return {
        backend: 'claude',
        loggedIn: await probeClaudeCodeLogin(configDir),
      };
    },

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

    async appendSessionHistory(input: AppendSessionHistoryInput): Promise<void> {
      await appendClaudeCodeSessionHistory({
        sessionId: input.sessionId,
        cwd: input.cwd,
        turns: input.turns,
        configDir,
        signal: input.signal,
      });
    },
  };
}

export const claudeBackendProvider: BackendProvider = createClaudeBackendProvider();
