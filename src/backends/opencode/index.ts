import type {
  AppendSessionHistoryInput,
  Backend,
  BackendProvider,
  BackendWorkerBridge,
} from '../../core/backend.js';
import type { PtyProvider } from '../../runners/types.js';
import { OPENCODE_DESCRIPTOR } from './descriptor.js';
import { OpenCodeBackend } from './backend.js';
import { OpenCodeWorkerBridge } from './worker-bridge.js';
import { appendOpenCodeSessionHistory } from './history-writer.js';

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

  async appendSessionHistory(input: AppendSessionHistoryInput): Promise<void> {
    await appendOpenCodeSessionHistory({
      sessionId: input.sessionId,
      cwd: input.cwd,
      turns: input.turns,
      signal: input.signal,
    });
  },
};
