import type { BackendDescriptor } from '../../core/worker-types.js';

export const OPENCODE_DESCRIPTOR: BackendDescriptor = {
  id: 'opencode',
  label: 'OpenCode',
  description: 'OpenCode local-private CLI backend.',
  commandDisplay: 'opencode run --pure --format json',
  pendingReplyMessage: 'OpenCode is working...',
  assistantLabel: 'OpenCode',
  sessionIdLabel: 'OpenCode session',
  defaultModel: null,
  models: [],
  modelSource: 'backend',
  executionModes: ['default', 'danger-full-access'],
  defaultReasoningEffort: null,
  defaultReasoningEffortsByModel: {},
  reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
  reasoningEffortsByModel: {},
  contextWindowsByModel: {},
  contextWindow: null,
  capabilities: {
    streaming: false,
    streamingGranularity: 'none',
    backgroundAssistant: false,
    reasoningContent: false,
    abort: true,
    persistentProcess: false,
  },
};
