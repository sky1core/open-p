import { registerBackend } from '../../src/core/backend-registry.js';
import type { BackendProvider } from '../../src/core/backend.js';
import type { BackendRunOptions, TurnRequest, TurnResult } from '../../src/core/types.js';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';

const provider: BackendProvider = {
  id: 'test-direct-cli',
  descriptor: {} as never,
  createBackend: () => ({
    runTurn: async (request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> => {
      const scenario = process.env.OPENP_TEST_DIRECT_CLI_SCENARIO;
      if (scenario === 'text-mismatch') {
        options.onIntermediateText?.('working draft', 'jsonl');
        return result(request, 'done');
      }
      if (scenario === 'text-replacement-before-result') {
        options.onIntermediateText?.('first progress', 'jsonl');
        options.onIntermediateText?.('first progress\n\nsecond progress', 'jsonl');
        return result(request, 'result answer');
      }
      if (scenario === 'assistant-snapshot-replacement-before-result') {
        options.onIntermediateText?.('first progress', 'jsonl');
        options.onIntermediateAssistantSnapshot?.(assistantTextSnapshot('snap-1', 'first progress'), 'jsonl');
        options.onIntermediateText?.('first progress\n\nsecond progress', 'jsonl');
        options.onIntermediateAssistantSnapshot?.(assistantTextSnapshot('snap-2', 'second progress'), 'jsonl');
        return result(request, 'result answer');
      }
      if (scenario === 'assistant-snapshot-reasoning-and-text') {
        options.onIntermediateReasoning?.('thinking', 'jsonl');
        options.onIntermediateText?.('answer', 'jsonl');
        options.onIntermediateAssistantSnapshot?.(assistantTextAndReasoningSnapshot('snap-mixed', 'thinking', 'answer'), 'jsonl');
        return result(request, 'answer', 'thinking');
      }
      if (scenario === 'background-assistant-snapshot') {
        options.onIntermediateAssistantSnapshot?.(backgroundAssistantSnapshot(), 'jsonl');
        return result(request, 'active result');
      }
      if (scenario === 'text-prefix-result-tail') {
        options.onIntermediateText?.('A', 'jsonl');
        options.onIntermediateText?.('AB', 'jsonl');
        return result(request, 'ABC');
      }
      if (scenario === 'reasoning-before-text-replacement') {
        options.onIntermediateReasoning?.('thinking', 'jsonl');
        options.onIntermediateText?.('draft', 'jsonl');
        options.onIntermediateText?.('draft\n\nanswer', 'jsonl');
        return result(request, 'answer', 'thinking');
      }
      if (scenario === 'reasoning-mismatch') {
        options.onIntermediateReasoning?.('first draft', 'jsonl');
        return result(request, 'done', 'replacement');
      }
      if (scenario === 'streaming-reasoning-replacement') {
        options.onIntermediateReasoning?.('first draft', 'jsonl');
        options.onIntermediateReasoning?.('first draft\n\nreplacement', 'jsonl');
        options.onIntermediateText?.('done', 'jsonl');
        return result(request, 'done', 'replacement');
      }
      if (scenario === 'reasoning-tail-after-text') {
        options.onIntermediateReasoning?.('think', 'jsonl');
        options.onIntermediateText?.('answer', 'jsonl');
        options.onIntermediateReasoning?.('think\n\nlater reasoning', 'jsonl');
        return result(request, 'answer', 'later reasoning');
      }
      if (scenario === 'text-first-result-reasoning') {
        options.onIntermediateText?.('answer', 'jsonl');
        return result(request, 'answer', 'thinking');
      }
      throw new Error(`unsupported test direct CLI scenario: ${scenario ?? '(unset)'}`);
    },
  }),
  createWorkerBridge: () => ({
    runTurn: async () => {
      throw new Error('test-direct-cli worker bridge is not used by direct CLI tests');
    },
    isChildAliveForSession: async () => false,
    shutdown: async () => {},
  }),
  resolveSessionLogPath: async () => null,
};

registerBackend(provider);

function assistantTextSnapshot(id: string, text: string) {
  return {
    semanticKind: 'commentary' as const,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: null,
    },
  };
}

function assistantTextAndReasoningSnapshot(id: string, reasoning: string, text: string) {
  return {
    semanticKind: 'commentary' as const,
    message: {
      id,
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: reasoning },
        { type: 'text', text },
      ],
      stop_reason: null,
    },
  };
}

function backgroundAssistantSnapshot() {
  return {
    semanticKind: 'background' as const,
    message: {
      id: 'snap-background',
      role: 'assistant',
      content: [
        { type: 'text', text: 'background done' },
        { type: 'tool_use', id: 'toolu_bg', name: 'Read', input: { file_path: 'bg.txt' } },
      ],
      stop_reason: 'end_turn',
    },
  };
}

function result(request: TurnRequest, text: string, reasoningContent: string | null = null): TurnResult {
  return {
    turnId: request.turnId,
    text,
    reasoningContent,
    sessionId: SESSION_ID,
    diagnostics: {
      durationMs: 1,
      stopReason: 'end_turn',
      toolsUsed: [],
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
      },
      rawEventCount: 0,
    },
  };
}
