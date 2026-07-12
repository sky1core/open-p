import type { BackendProvider, Backend, BackendWorkerBridge } from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { KIRO_DESCRIPTOR } from './descriptor.js';
import { KiroBackend } from './backend.js';
import { KiroWorkerBridge } from './worker-bridge.js';
import { resolveKiroSessionLogPath } from './session-log.js';
import { probeKiroLogin } from './login.js';

export const kiroBackendProvider: BackendProvider = {
  id: 'kiro',
  descriptor: KIRO_DESCRIPTOR,

  async probeLogin() {
    return {
      backend: 'kiro',
      loggedIn: await probeKiroLogin(),
    };
  },

  createBackend(_provider: PtyProvider): Backend {
    return new KiroBackend();
  },

  createWorkerBridge(): BackendWorkerBridge {
    return new KiroWorkerBridge();
  },

  async resolveSessionLogPath(sessionId: string, _cwd: string): Promise<string | null> {
    return resolveKiroSessionLogPath(sessionId);
  },
};
