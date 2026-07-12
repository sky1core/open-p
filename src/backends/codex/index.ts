import type { BackendProvider, Backend, BackendWorkerBridge } from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { CODEX_DESCRIPTOR } from './descriptor.js';
import { CodexWorkerBridge } from './worker-bridge.js';
import { findCodexSessionLogPath } from './session-log.js';
import { CodexBackend } from './backend.js';
import { probeCodexLogin } from './login.js';

export interface CodexBackendProviderOptions {
  readonly id?: string;
  readonly homeDir?: string | null;
}

export function createCodexBackendProvider(options: CodexBackendProviderOptions = {}): BackendProvider {
  const id = options.id ?? 'codex';
  const homeDir = options.homeDir ?? null;
  const descriptor = id === CODEX_DESCRIPTOR.id
    ? CODEX_DESCRIPTOR
    : {
        ...CODEX_DESCRIPTOR,
        id,
        label: id,
      };

  return {
    id,
    descriptor,

    async probeLogin() {
      return {
        backend: 'codex',
        loggedIn: await probeCodexLogin(homeDir),
      };
    },

    createBackend(_provider: PtyProvider): Backend {
      return new CodexBackend({ homeDir });
    },

    createWorkerBridge(): BackendWorkerBridge {
      return new CodexWorkerBridge({ homeDir });
    },

    async resolveSessionLogPath(sessionId: string, _cwd: string): Promise<string | null> {
      return findCodexSessionLogPath(sessionId, homeDir);
    },
  };
}

export const codexBackendProvider: BackendProvider = createCodexBackendProvider();
