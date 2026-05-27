import type { BackendProvider, Backend, BackendWorkerBridge } from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { CODEX_DESCRIPTOR } from './descriptor.js';
import { CodexWorkerBridge } from './worker-bridge.js';
import { findCodexSessionLogPath } from './session-log.js';
import { CodexBackend } from './backend.js';

export const codexBackendProvider: BackendProvider = {
  id: 'codex',
  descriptor: CODEX_DESCRIPTOR,

  createBackend(_provider: PtyProvider): Backend {
    return new CodexBackend();
  },

  createWorkerBridge(): BackendWorkerBridge {
    return new CodexWorkerBridge();
  },

  async resolveSessionLogPath(sessionId: string, _cwd: string): Promise<string | null> {
    return findCodexSessionLogPath(sessionId);
  },
};
