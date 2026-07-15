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
import {
  appendOpenCodeSessionHistory,
  cleanupOpenCodePreparedSessionHistoryAppend,
} from './history-writer.js';
import { readOpenCodeNativeSession } from './native-reader.js';

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

  async readNativeSession(input) {
    return readOpenCodeNativeSession({
      backend: 'opencode',
      sessionId: input.sessionId,
      cwd: input.cwd,
      mode: input.mode,
      signal: input.signal,
    });
  },

  async appendSessionHistory(input: AppendSessionHistoryInput) {
    return appendOpenCodeSessionHistory({
      sessionId: input.sessionId,
      cwd: input.cwd,
      turns: input.turns,
      persistPreparedAppend: input.persistPreparedAppend,
      signal: input.signal,
    });
  },

  async cleanupPreparedSessionHistoryAppend(input) {
    return cleanupOpenCodePreparedSessionHistoryAppend(input);
  },
};
