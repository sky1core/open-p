import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatWorkerTurnResult } from '../src/core/output.js';
import {
  EXIT_CODES,
  OpenPError,
} from '../src/core/errors.js';
import {
  extractKiroPromptScopedAssistantText,
  extractKiroTurnResult,
  extractKiroTurnResultText,
  resolveKiroSessionLogPath,
} from '../src/backends/kiro/session-log.js';

function readKiroFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/kiro/${name}`, import.meta.url), 'utf8');
}

function firstBlocks(events: readonly any[]): any[] {
  return events.map((event) => (event.message.content as any[])[0]);
}

function openPOutputForKiroResult(result: ReturnType<typeof extractKiroTurnResult>): any {
  const output = formatWorkerTurnResult({
    content: result.text ?? '',
    reasoningContent: null,
    assistantEvents: result.assistantEvents,
    sessionId: '019e0000-0000-7000-8000-000000009999',
    diagnostics: {
      numTurns: 1,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      contextWindow: null,
      lastSubturnContextTokens: null,
      durationMs: 1,
      totalCostUsd: null,
      stopReason: 'end_turn',
      toolsUsed: result.toolsUsed,
      autoCompacted: null,
      intermediateTextCount: null,
    },
  }, {
    turnId: 'turn_redacted_fixture',
    backend: 'kiro',
  });
  return JSON.parse(output).openp.output;
}

const KIRO_COMPACTION_DATA = {
  summary: 'dummy summary',
  strategy: {
    message_pairs_to_exclude: 1,
    context_window_percent_to_exclude: 1,
    truncate_large_messages: false,
    max_message_length: 25000,
  },
  messages_snapshot: [],
};

test('resolveKiroSessionLogPath resolves the Kiro cli session jsonl path', () => {
  assert.equal(
    resolveKiroSessionLogPath('33333333-3333-4333-8333-333333333333', { HOME: '/tmp/openp-home' }),
    join('/tmp/openp-home', '.kiro', 'sessions', 'cli', '33333333-3333-4333-8333-333333333333.jsonl'),
  );
});

test('resolveKiroSessionLogPath rejects path-unsafe session ids', () => {
  assert.equal(resolveKiroSessionLogPath('../bad', { HOME: '/tmp/openp-home' }), null);
});

test('extractKiroTurnResultText reads assistant text after the scoped prompt', () => {
  const log = [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'hello' }], meta: { timestamp: 1 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'A' }] },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'ToolResults',
      data: { content: [{ kind: 'toolResult', data: { toolUseId: 'tooluse_read', content: [{ kind: 'text', data: 'tool output' }] } }] },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'B' }, { kind: 'toolUse', data: { toolUseId: 'tooluse_read', name: 'read' } }] },
    }),
  ].join('\n');

  assert.equal(extractKiroTurnResultText(log), 'A\n\nB');
  const result = extractKiroTurnResult(log);
  assert.equal(result.text, 'A\n\nB');
  assert.deepEqual(result.toolsUsed, ['read']);
  assert.equal(result.assistantEvents.length, 2);
  const toolResult = result.assistantEvents[0]!.message.content as any[];
  assert.equal(toolResult[0].type, 'tool_result');
  assert.equal(toolResult[0].tool_use_id, 'tooluse_read');
  assert.equal(toolResult[0].content, 'tool output');
  const toolUse = result.assistantEvents[1]!.message.content as any[];
  assert.equal(toolUse[0].type, 'tool_use');
  assert.equal(toolUse[0].id, 'tooluse_read');
  assert.equal(toolUse[0].name, 'read');
});

test('extractKiroTurnResult preserves redacted Kiro long-answer session-log fixture', () => {
  const result = extractKiroTurnResult(readKiroFixture('redacted-session-log-long-answer-no-tool.jsonl'));
  const publicOutput = openPOutputForKiroResult(result);

  assert.equal(result.text?.length, 1364);
  assert.equal(result.assistantEvents.length, 0);
  assert.deepEqual(result.toolsUsed, []);
  assert.equal(publicOutput.answer.length, 1);
  assert.equal(publicOutput.toolCall.length, 0);
  assert.equal(publicOutput.toolResult.length, 0);
});

test('extractKiroTurnResult preserves redacted Kiro tool-use session-log fixture artifacts', () => {
  const result = extractKiroTurnResult(readKiroFixture('redacted-session-log-tool-use-file.jsonl'));
  const blocks = firstBlocks(result.assistantEvents);
  const publicOutput = openPOutputForKiroResult(result);

  assert.equal(result.text?.includes('sum=233'), true);
  assert.equal(result.text?.length, 804);
  assert.deepEqual(result.toolsUsed, ['read', 'write']);
  assert.deepEqual(blocks.map((block) => block.type), ['tool_use', 'tool_result', 'tool_use', 'tool_result']);
  assert.equal(blocks[0].name, 'read');
  assert.equal(blocks[1].tool_use_id, blocks[0].id);
  assert.equal(blocks[2].name, 'write');
  assert.equal(blocks[3].tool_use_id, blocks[2].id);
  assert.equal(publicOutput.answer.length, 1);
  assert.equal(publicOutput.toolCall.length, 2);
  assert.equal(publicOutput.toolResult.length, 2);
});

test('extractKiroTurnResult preserves redacted Kiro denied permission tool-result fixture artifacts', () => {
  const result = extractKiroTurnResult(readKiroFixture('redacted-session-log-permission-tool-use.jsonl'));
  const blocks = firstBlocks(result.assistantEvents);

  assert.equal(result.text?.includes('파일 쓰기가 거부되었습니다'), true);
  assert.equal(result.text?.length, 511);
  assert.deepEqual(result.toolsUsed, ['read', 'write']);
  assert.deepEqual(blocks.map((block) => block.type), ['tool_use', 'tool_result', 'tool_use', 'tool_result']);
  assert.equal(blocks[1].tool_use_id, blocks[0].id);
  assert.equal(blocks[3].tool_use_id, blocks[2].id);
  assert.equal(String(blocks[3].content).includes('denied'), true);
});

test('extractKiroTurnResult preserves json tool result content', () => {
  const log = [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'read json' }], meta: { timestamp: 1 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'ToolResults',
      data: {
        content: [{
          kind: 'toolResult',
          data: {
            toolUseId: 'tooluse_json',
            content: [{ kind: 'json', data: { ok: true, items: [1, 2] } }],
          },
        }],
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'done' }] },
    }),
  ].join('\n');

  const result = extractKiroTurnResult(log);
  assert.equal(result.text, 'done');
  const toolResult = result.assistantEvents[0]!.message.content as any[];
  assert.equal(toolResult[0].type, 'tool_result');
  assert.equal(toolResult[0].tool_use_id, 'tooluse_json');
  assert.equal(toolResult[0].content, '{"ok":true,"items":[1,2]}');
});

test('extractKiroTurnResult preserves artifacts across compaction and non-caller prompt continuations', () => {
  const log = [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'caller prompt' }], meta: { timestamp: 1 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        content: [
          { kind: 'text', data: 'answer A' },
          { kind: 'toolUse', data: { toolUseId: 'tooluse_read', name: 'read' } },
        ],
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'ToolResults',
      data: {
        content: [{
          kind: 'toolResult',
          data: {
            toolUseId: 'tooluse_read',
            content: [{ kind: 'text', data: 'read output' }],
          },
        }],
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'Compaction',
      data: KIRO_COMPACTION_DATA,
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: {
        message_id: 'tool-result-prompt',
        content: [{
          kind: 'toolResult',
          data: {
            toolUseId: 'tooluse_cancelled',
            content: [{ kind: 'text', data: 'Tool use was cancelled by the user' }],
          },
        }],
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'ToolResults',
      data: {
        content: [{
          kind: 'toolResult',
          data: {
            toolUseId: 'tooluse_after_compaction',
            content: [{ kind: 'text', data: 'post-compaction tool output' }],
          },
        }],
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        content: [
          { kind: 'text', data: 'answer B' },
          { kind: 'toolUse', data: { toolUseId: 'tooluse_write', name: 'write' } },
        ],
      },
    }),
  ].join('\n');

  const result = extractKiroTurnResult(log);
  const blocks = firstBlocks(result.assistantEvents);

  assert.equal(result.text, 'answer A\n\nanswer B');
  assert.deepEqual(result.toolsUsed, ['read', 'write']);
  assert.deepEqual(blocks.map((block) => block.type), ['tool_use', 'tool_result', 'tool_result', 'tool_use']);
  assert.equal(blocks[0].name, 'read');
  assert.equal(blocks[1].tool_use_id, 'tooluse_read');
  assert.equal(blocks[2].tool_use_id, 'tooluse_after_compaction');
  assert.equal(blocks[3].name, 'write');
});

test('extractKiroTurnResult continues when compaction is followed by ToolResults without a prompt', () => {
  const log = [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'caller prompt' }], meta: { timestamp: 1 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'toolUse', data: { toolUseId: 'tooluse_read', name: 'read' } }] },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'Compaction',
      data: KIRO_COMPACTION_DATA,
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'ToolResults',
      data: {
        content: [{
          kind: 'toolResult',
          data: {
            toolUseId: 'tooluse_read',
            content: [{ kind: 'text', data: 'read output after compaction' }],
          },
        }],
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'answer after compaction' }] },
    }),
  ].join('\n');

  const result = extractKiroTurnResult(log);
  const blocks = firstBlocks(result.assistantEvents);

  assert.equal(result.text, 'answer after compaction');
  assert.deepEqual(result.toolsUsed, ['read']);
  assert.deepEqual(blocks.map((block) => block.type), ['tool_use', 'tool_result']);
  assert.equal(blocks[1].tool_use_id, 'tooluse_read');
});

test('extractKiroTurnResult fails closed on multiple caller prompt boundaries', () => {
  const log = [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'first caller prompt' }], meta: { timestamp: 1 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'first answer' }] },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'second caller prompt' }], meta: { timestamp: 2 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'second answer' }] },
    }),
  ].join('\n');

  assert.throws(
    () => extractKiroTurnResult(log),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('Kiro prompt parsers fail closed on mixed prompt content blocks', () => {
  assertUnsupportedPromptShapeThrows(JSON.stringify({
    version: 'v1',
    kind: 'Prompt',
    data: {
      content: [
        { kind: 'text', data: 'text block' },
        {
          kind: 'toolResult',
          data: {
            toolUseId: 'tooluse_mixed',
            content: [{ kind: 'text', data: 'tool result block' }],
          },
        },
      ],
      meta: { timestamp: 1 },
    },
  }));
});

test('Kiro prompt parsers fail closed on text-only prompt content without meta', () => {
  assertUnsupportedPromptShapeThrows(JSON.stringify({
    version: 'v1',
    kind: 'Prompt',
    data: {
      content: [{ kind: 'text', data: 'text block without meta' }],
    },
  }));
});

test('Kiro prompt parsers fail closed on empty prompt content', () => {
  assertUnsupportedPromptShapeThrows(JSON.stringify({
    version: 'v1',
    kind: 'Prompt',
    data: {
      content: [],
      meta: { timestamp: 1 },
    },
  }));
});

test('Kiro prompt parsers fail closed on non-array prompt content', () => {
  assertUnsupportedPromptShapeThrows(JSON.stringify({
    version: 'v1',
    kind: 'Prompt',
    data: {
      content: { kind: 'text', data: 'not an array' },
      meta: { timestamp: 1 },
    },
  }));
});

test('extractKiroTurnResultText fails closed without a prompt-scoped assistant message', () => {
  const log = JSON.stringify({
    version: 'v1',
    kind: 'AssistantMessage',
    data: { content: [{ kind: 'text', data: 'unscoped answer' }] },
  });

  assert.equal(extractKiroTurnResultText(log), null);
});

test('extractKiroTurnResultText keeps active answer even when it matches setup assistant text', () => {
  const log = [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'hello' }], meta: { timestamp: 1 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'Effort set to high.' }] },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'actual answer' }] },
    }),
  ].join('\n');

  assert.equal(extractKiroTurnResultText(log), 'Effort set to high.\n\nactual answer');
});

test('extractKiroPromptScopedAssistantText reads the first setup prompt response after offset', () => {
  const log = [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: '/effort high' }], meta: { timestamp: 1 } },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'effort changed' }] },
    }),
  ].join('\n');

  assert.deepEqual(extractKiroPromptScopedAssistantText(log), {
    promptFound: true,
    text: 'effort changed',
    texts: ['effort changed'],
  });
});

function assertUnsupportedPromptShapeThrows(log: string): void {
  const isUnsupportedPromptShape = (error: unknown): boolean => (
    error instanceof OpenPError &&
    error.exitCode === EXIT_CODES.protocolViolation &&
    /unsupported prompt shape/.test(error.message)
  );

  assert.throws(() => extractKiroTurnResult(log), isUnsupportedPromptShape);
  assert.throws(() => extractKiroPromptScopedAssistantText(log), isUnsupportedPromptShape);
}

test('extractKiroPromptScopedAssistantText reports missing assistant text separately from missing prompt', () => {
  const log = JSON.stringify({
    version: 'v1',
    kind: 'Prompt',
    data: { content: [{ kind: 'text', data: '/effort high' }], meta: { timestamp: 1 } },
  });

  assert.deepEqual(extractKiroPromptScopedAssistantText(log), {
    promptFound: true,
    text: null,
    texts: [],
  });
  assert.deepEqual(extractKiroPromptScopedAssistantText(''), {
    promptFound: false,
    text: null,
    texts: [],
  });
});
