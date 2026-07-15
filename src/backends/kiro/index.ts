import type {
  AppendSessionHistoryInput,
  Backend,
  BackendProvider,
  BackendWorkerBridge,
} from '../../core/backend.js';
import { createSeedStorageIdentity } from '../../core/seed-storage-identity.js';
import type { PtyProvider } from '../../runners/types.js';
import { KIRO_DESCRIPTOR } from './descriptor.js';
import { KiroBackend } from './backend.js';
import { KiroWorkerBridge } from './worker-bridge.js';
import { resolveKiroHome, resolveKiroSessionLogPath } from './session-log.js';
import {
  appendKiroSessionHistory,
  cleanupKiroPreparedSessionHistoryAppend,
} from './history-writer.js';
import { probeKiroLogin } from './login.js';
import { readKiroNativeSession } from './native-reader.js';

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

  async resolveSeedStorageIdentity(input) {
    return createSeedStorageIdentity({
      backendFamily: 'kiro',
      providerId: 'kiro',
      cwd: input.cwd,
      storageRoot: resolveKiroHome(),
    });
  },

  async readNativeSession(input) {
    return readKiroNativeSession({
      backend: 'kiro',
      sessionId: input.sessionId,
      mode: input.mode,
    });
  },

  async appendSessionHistory(input: AppendSessionHistoryInput) {
    return appendKiroSessionHistory({
      sessionId: input.sessionId,
      cwd: input.cwd,
      turns: input.turns,
      persistPreparedAppend: input.persistPreparedAppend,
      signal: input.signal,
    });
  },

  async cleanupPreparedSessionHistoryAppend(input) {
    return cleanupKiroPreparedSessionHistoryAppend(input);
  },
};
