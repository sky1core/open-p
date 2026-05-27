import type { BackendDescriptor } from '../../core/worker-types.js';

export const CODEX_DESCRIPTOR: BackendDescriptor = {
  id: 'codex',
  label: 'Codex',
  description: 'Codex CLI non-interactive exec mode.',
  commandDisplay: 'codex exec --json',
  pendingReplyMessage: 'Codex is working...',
  assistantLabel: 'Codex',
  sessionIdLabel: 'Codex session',
  defaultModel: null,
  models: [],
  modelSource: 'backend',
  executionModes: ['default', 'danger-full-access'],
  defaultReasoningEffort: null,
  defaultReasoningEffortsByModel: {},
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  reasoningEffortsByModel: {},
  contextWindowsByModel: {},
  contextWindow: null,
  capabilities: {
    streaming: true,
    streamingGranularity: 'subturn',
    backgroundAssistant: false,
    reasoningContent: true,
    abort: true,
    persistentProcess: false,
  },
};
