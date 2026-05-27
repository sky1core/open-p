import type { BackendDescriptor } from '../../core/worker-types.js';

export const CLAUDE_CODE_DESCRIPTOR: BackendDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  description: 'Claude Code interactive CLI through a PTY-backed compatibility layer.',
  commandDisplay: 'claude',
  pendingReplyMessage: 'Claude Code is working...',
  assistantLabel: 'Claude',
  sessionIdLabel: 'Claude Code session',
  defaultModel: null,
  models: [],
  modelSource: 'backend',
  executionModes: [
    'default',
    'danger-full-access',
  ],
  defaultReasoningEffort: null,
  defaultReasoningEffortsByModel: {},
  reasoningEfforts: [],
  reasoningEffortsByModel: {},
  contextWindowsByModel: {},
  contextWindow: null,
  capabilities: {
    streaming: true,
    streamingGranularity: 'subturn',
    backgroundAssistant: false,
    reasoningContent: true,
    abort: true,
    persistentProcess: true,
  },
};
