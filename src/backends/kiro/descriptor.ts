import type { BackendDescriptor } from '../../core/worker-types.js';

export const KIRO_DESCRIPTOR: BackendDescriptor = {
  id: 'kiro',
  label: 'Kiro',
  description: 'Kiro CLI Agent Client Protocol mode.',
  commandDisplay: 'kiro-cli acp',
  pendingReplyMessage: 'Kiro is working...',
  assistantLabel: 'Kiro',
  sessionIdLabel: 'Kiro session',
  defaultModel: null,
  models: [],
  modelSource: 'backend',
  executionModes: ['default', 'danger-full-access'],
  defaultReasoningEffort: null,
  defaultReasoningEffortsByModel: {},
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  reasoningEffortsByModel: {},
  contextWindowsByModel: {},
  contextWindow: null,
  capabilities: {
    streaming: true,
    streamingGranularity: 'subturn',
    backgroundAssistant: false,
    reasoningContent: false,
    abort: true,
    persistentProcess: false,
  },
};
