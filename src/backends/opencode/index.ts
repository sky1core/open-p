import type { BackendProvider, Backend, BackendWorkerBridge } from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { OPENCODE_DESCRIPTOR } from './descriptor.js';
import { OpenCodeBackend } from './backend.js';
import { OpenCodeWorkerBridge } from './worker-bridge.js';

export const opencodeBackendProvider: BackendProvider = {
  id: 'opencode',
  descriptor: OPENCODE_DESCRIPTOR,

  createBackend(_provider: PtyProvider): Backend {
    return new OpenCodeBackend();
  },

  createWorkerBridge(): BackendWorkerBridge {
    return new OpenCodeWorkerBridge();
  },

  async resolveSessionLogPath(_sessionId: string, _cwd: string): Promise<string | null> {
    return null;
  },
};
