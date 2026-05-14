import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runStreamJsonWorkerLines, type StreamJsonWorkerBridge } from '../src/core/stream-json-worker-runner.js';
import type { CliOptions } from '../src/core/cli-args.js';
import { SessionLockStore } from '../src/core/session-lock.js';
import { SessionStateStore } from '../src/core/session-state.js';
import { parseStreamJsonLines } from '../src/core/stream-json-parser.js';
import type { AssistantEventSnapshot } from '../src/core/types.js';
import type { WorkerTurnRequest, WorkerTurnResult } from '../src/core/worker-types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CLAUDE_P_NON_PARTIAL_STREAM_JSON_EVENT_TYPES = [
  'system',
  'rate_limit_event',
  'assistant',
  'assistant',
  'result',
];

class FakeBridge implements StreamJsonWorkerBridge {
  readonly requests: WorkerTurnRequest[] = [];
  shutdownCount = 0;

  constructor(
    private readonly onRun?: (request: WorkerTurnRequest) => void,
    private readonly reasoningContent: string | null = null,
    private readonly emitTextPartials = true,
    private readonly assistantEvents?: readonly AssistantEventSnapshot[],
    private readonly intermediateTexts: readonly string[] = ['worker', 'worker final'],
    private readonly content = 'worker final',
  ) {}

  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    this.requests.push(request);
    this.onRun?.(request);
    if (this.emitTextPartials) {
      for (const text of this.intermediateTexts) {
        request.onIntermediateText?.(text, 'jsonl');
      }
    }
    return {
      content: this.content,
      reasoningContent: this.reasoningContent,
      ...(this.assistantEvents ? { assistantEvents: this.assistantEvents } : {}),
      sessionId: request.sessionId ?? SESSION_ID,
      diagnostics: {
        numTurns: this.requests.length,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        contextWindow: 200000,
        lastSubturnContextTokens: 13,
        durationMs: 25,
        totalCostUsd: null,
        stopReason: 'end_turn',
        toolsUsed: [],
        autoCompacted: false,
        intermediateTextCount: 2,
      },
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
  }
}

test('stream-json worker uses open-p WorkerBridge instead of forwarding backend print-mode args', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  const code = await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([
      userEvent('turn-a', 'first prompt'),
      userEvent('turn-b', 'second prompt'),
    ]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  assert.equal(code, 0);
  assert.equal(bridge.shutdownCount, 1);
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.requests[0]?.isFirstTurn, true);
  assert.equal(bridge.requests[1]?.isFirstTurn, false);
  assert.equal(bridge.requests[0]?.message, 'first prompt');
  assert.equal(bridge.requests[1]?.message, 'second prompt');
  assert.equal(bridge.requests[0]?.sessionId, SESSION_ID);
  assert.equal(bridge.requests[0]?.projectRoot, '/work/open-p');
  assert.equal(bridge.requests[0]?.contextWindow, 200000);
  assert.deepEqual(bridge.requests[0]?.binArgs, []);
  const binArgs = [...(bridge.requests[0]?.binArgs ?? [])] as string[];
  assert.equal(binArgs.includes('-p'), false);
  assert.equal(binArgs.includes('--print'), false);

  const events = parseEvents(output.join(''));
  assert.deepEqual(events.map((event) => event.type), [
    'system',
    'assistant',
    'assistant',
    'result',
    'assistant',
    'assistant',
    'result',
  ]);
  assert.equal(events[0]?.subtype, 'init');
  assert.equal(events[0]?.session_id, SESSION_ID);
  assert.equal(events[1]?.session_id, SESSION_ID);
  assert.equal(events[1]?.message?.content?.[0]?.text, 'worker');
  assert.equal(events[2]?.message?.content?.[0]?.text, 'worker final');
  assert.equal(events[3]?.result, 'worker final');
  assert.equal(events[6]?.result, 'worker final');
  for (const event of events) {
    assertNoOpenPOnlyFields(event);
  }
});

test('stream-json worker matches observed claude -p non-partial streaming order', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.map((event) => event.type),
    requiredOpenPEventTypesFromClaudeP(CLAUDE_P_NON_PARTIAL_STREAM_JSON_EVENT_TYPES),
  );
  const resultIndex = events.findIndex((event) => event.type === 'result');
  const assistantIndexes = events
    .map((event, index) => event.type === 'assistant' ? index : -1)
    .filter((index) => index >= 0);
  assert.deepEqual(assistantIndexes, [1, 2]);
  assert.equal(assistantIndexes.every((index) => index < resultIndex), true);
});

test('stream-json worker streams non-partial JSONL assistant events before the result', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const resultIndex = events.findIndex((event) => event.type === 'result');
  const assistantTextsBeforeResult = events
    .slice(0, resultIndex)
    .filter((event) => event.type === 'assistant')
    .map((event) => event.message?.content?.[0]?.text);

  assert.deepEqual(assistantTextsBeforeResult, ['worker', 'worker final']);
  assert.equal(resultIndex > 0, true);
});

test('stream-json worker preserves result order after assistant output without timing padding', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const assistantIndexes = events
    .map((event, index) => event.type === 'assistant' ? index : -1)
    .filter((index) => index >= 0);
  const resultIndex = events.findIndex((event) => event.type === 'result');

  assert.equal(assistantIndexes.length, 2);
  assert.equal(resultIndex > assistantIndexes.at(-1)!, true);
});

test('stream-json worker separates formatter fallback assistant from the result', async () => {
  const bridge = new FakeBridge(undefined, null, false);
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const assistantIndexes = events
    .map((event, index) => event.type === 'assistant' ? index : -1)
    .filter((index) => index >= 0);
  const resultIndex = events.findIndex((event) => event.type === 'result');

  assert.equal(assistantIndexes.length, 1);
  assert.equal(events[assistantIndexes[0]!]?.message?.content?.[0]?.text, 'worker final');
  assert.equal(resultIndex > assistantIndexes[0]!, true);
});

test('stream-json worker output parses streamed assistant updates without prefix duplication', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const parsedIntermediate: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const result = parseStreamJsonLines(output.join('').trim().split('\n'), {
    onIntermediateText: (text) => parsedIntermediate.push(text),
  });

  assert.deepEqual(parsedIntermediate, ['worker', 'worker final']);
  assert.equal(result?.content, 'worker final');
  assert.equal(result?.diagnostics.inputTokens, 10);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.stopReason, 'end_turn');
});

test('stream-json worker output parses preserved metadata snapshots without duplicate text', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    [{
      message: {
        id: 'msg_backend',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'worker final' }],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        diagnostics: null,
        context_management: null,
      },
    }],
  );
  const output: string[] = [];
  const parsedIntermediate: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(events.map((event) => event.type), ['system', 'assistant', 'assistant', 'result']);
  assert.equal(
    events.some((event) => event.type === 'assistant' && event.message?.id === 'msg_backend'),
    false,
  );

  const result = parseStreamJsonLines(output.join('').trim().split('\n'), {
    onIntermediateText: (text) => parsedIntermediate.push(text),
  });

  assert.deepEqual(parsedIntermediate, ['worker', 'worker final']);
  assert.equal(result?.content, 'worker final');
  assert.equal(result?.diagnostics.inputTokens, 10);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.stopReason, 'end_turn');
});

test('stream-json worker does not repeat a streamed final text snapshot', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    [{
      message: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'worker final' }],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        diagnostics: null,
        context_management: null,
      },
    }],
  );
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(events.map((event) => event.type), ['system', 'assistant', 'assistant', 'result']);
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['worker', 'worker final'],
  );
  assert.equal(events.at(-1)?.result, 'worker final');
});

test('stream-json worker does not repeat any already-streamed text snapshots', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  );
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(events.map((event) => event.type), ['system', 'assistant', 'assistant', 'result']);
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['worker', 'worker final'],
  );
});

test('stream-json worker preserves final reasoning when suppressing duplicate streamed text', async () => {
  const bridge = new FakeBridge(undefined, 'thinking done');
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const assistantEvents = events.filter((event) => event.type === 'assistant');
  const finalAssistantBeforeResult = events[events.findIndex((event) => event.type === 'result') - 1];
  assert.deepEqual(assistantEvents.map((event) => event.message?.content?.[0]?.text), ['worker', 'worker final', undefined]);
  assert.deepEqual(finalAssistantBeforeResult?.message?.content?.map((block: any) => block.type), ['thinking']);
  assert.equal(finalAssistantBeforeResult?.message?.content?.[0]?.thinking, 'thinking done');
});

test('stream-json worker rejects non-prefix streamed previews before result', async () => {
  const bridge = new FakeBridge(undefined, null, true, undefined, ['first draft', 'second draft'], 'first draft');
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['first draft'],
  );
  assert.equal(events.at(-1)?.result, 'first draft');
});

test('stream-json worker suppresses duplicate fallback for the latest streamed text', async () => {
  const bridge = new FakeBridge(undefined, null, true, undefined, ['first', 'first draft'], 'first draft');
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['first', 'first draft'],
  );
  assert.equal(events.at(-1)?.result, 'first draft');
});

test('stream-json worker keeps stale preview separate from authoritative result', async () => {
  const bridge = new FakeBridge(undefined, null, true, undefined, ['stale preview'], 'correct final');
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['stale preview', 'correct final'],
  );
  assert.equal(events.at(-1)?.result, 'correct final');
});

test('stream-json worker keeps stale prefix preview separate from authoritative result', async () => {
  const bridge = new FakeBridge(undefined, null, true, undefined, ['Hello', 'Hello typo'], 'Hello world');
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['Hello', 'Hello typo', 'Hello world'],
  );
  assert.equal(events.at(-1)?.result, 'Hello world');
});

test('stream-json worker suppresses raw final assistant when screen preview matches rendered markdown', async () => {
  const bridge = new FakeBridge(undefined, null, true, undefined, ['Title body'], '## Title body');
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['Title body'],
  );
  assert.equal(events.at(-1)?.result, '## Title body');
});

test('stream-json worker preserves final assistant event order when reasoning snapshots are present', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'thinking snapshot' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  );
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const resultIndex = events.findIndex((event) => event.type === 'result');
  const assistantEvents = events.slice(0, resultIndex).filter((event) => event.type === 'assistant');
  assert.deepEqual(
    assistantEvents.map((event) => event.message?.content?.map((block: any) => block.type)),
    [['text'], ['text'], ['thinking']],
  );
  assert.equal(assistantEvents.at(-1)?.message?.content?.[0]?.thinking, 'thinking snapshot');
});

test('stream-json worker streams non-partial reasoning assistant events before text and result', async () => {
  const bridge = new FakeBridge(
    (request) => {
      request.onIntermediateReasoning?.('thinking live');
    },
    null,
    true,
    [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'thinking live' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  );
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const resultIndex = events.findIndex((event) => event.type === 'result');
  const assistantEvents = events.slice(0, resultIndex).filter((event) => event.type === 'assistant');
  assert.deepEqual(
    assistantEvents.map((event) => event.message?.content?.map((block: any) => block.type)),
    [['thinking'], ['text'], ['text']],
  );
  assert.equal(assistantEvents[0]?.message?.content?.[0]?.thinking, 'thinking live');
  assert.deepEqual(
    assistantEvents.map((event) => event.message?.content?.[0]?.text).filter(Boolean),
    ['worker', 'worker final'],
  );
});

test('stream-json worker treats first input as resume when --resume was requested', async () => {
  const bridge = new FakeBridge();
  const state = await stateContext('/work/open-p');
  await saveCompatibleState(state.stateStore, '/work/open-p', null);

  await runStreamJsonWorkerLines({
    options: options({ resume: true }),
    lines: lines([userEvent('turn-a', 'resume prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: () => undefined,
  });

  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.requests[0]?.isFirstTurn, false);
  assert.equal(bridge.requests[0]?.sessionId, SESSION_ID);
});

test('stream-json worker emits Claude-style partial events from final WorkerBridge result', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ includePartialMessages: true }),
    lines: lines([userEvent('turn-a', 'partial prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(events.slice(0, 2).map((event) => `${event.type}:${event.subtype}`), ['system:init', 'system:status']);
  assert.ok(events.some((event) => event.type === 'stream_event' && event.event?.type === 'message_start'));
  assert.ok(events.some((event) => event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event?.delta?.type === 'text_delta'));
  assert.ok(events.some((event) => event.type === 'stream_event' && event.event?.type === 'message_stop'));
  assert.equal(events.at(-1)?.type, 'result');
  for (const event of events) {
    assertNoOpenPOnlyFields(event);
  }
});

test('stream-json worker excludes screen-sourced text from public partial events', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('screen preview', 'screen');
      request.onIntermediateText?.('jsonl progress', 'jsonl');
      return {
        content: 'jsonl progress final',
        reasoningContent: null,
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: null,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 1,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ includePartialMessages: true }),
    lines: lines([userEvent('turn-a', 'partial prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const textDeltas = parseEvents(output.join(''))
    .filter((event) => event.type === 'stream_event' && event.event?.delta?.type === 'text_delta')
    .map((event) => event.event.delta.text);
  assert.deepEqual(textDeltas, ['jsonl progress', ' final']);
});

test('stream-json worker excludes screen-sourced text from non-partial assistant preview events', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('jsonl', 'screen');
      request.onIntermediateText?.('jsonl progress', 'jsonl');
      return {
        content: 'jsonl progress',
        reasoningContent: null,
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: null,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 1,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const assistantTexts = parseEvents(output.join(''))
    .filter((event) => event.type === 'assistant')
    .map((event) => event.message?.content?.[0]?.text);
  assert.deepEqual(assistantTexts, ['jsonl progress']);
});

test('stream-json worker publishes JSONL assistant snapshot text and ignores prior screen preview', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('jsonl', 'screen');
      request.onIntermediateAssistantSnapshot?.({
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'jsonl progress' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'jsonl progress',
        reasoningContent: null,
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: null,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 1,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const assistantTexts = parseEvents(output.join(''))
    .filter((event) => event.type === 'assistant')
    .map((event) => event.message?.content?.[0]?.text);
  assert.deepEqual(assistantTexts, ['jsonl progress']);
});

test('stream-json worker uses JSONL snapshot when screen preview matches final markdown', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('Title', 'screen');
      request.onIntermediateAssistantSnapshot?.({
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '## Title' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: '## Title',
        reasoningContent: null,
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: null,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 1,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['## Title'],
  );
  assert.equal(events.at(-1)?.result, '## Title');
});

test('stream-json worker publishes replacement JSONL snapshot after ignoring screen preview', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('draft from screen', 'screen');
      request.onIntermediateAssistantSnapshot?.({
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'replacement from jsonl' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'replacement from jsonl',
        reasoningContent: null,
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: null,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 1,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant').map((event) => event.message?.content?.[0]?.text),
    ['replacement from jsonl'],
  );
  assert.equal(events.at(-1)?.result, 'replacement from jsonl');
});

test('stream-json worker completes partial reasoning from final result', async () => {
  const bridge = new FakeBridge((request) => {
    request.onIntermediateReasoning?.('think');
  }, 'thinking done', false);
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ includePartialMessages: true }),
    lines: lines([userEvent('turn-a', 'partial prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const thinkingDeltas = events
    .filter((event) => event.type === 'stream_event' && event.event?.delta?.type === 'thinking_delta')
    .map((event) => event.event.delta.thinking);
  assert.deepEqual(thinkingDeltas, ['think', 'ing done']);
});

test('stream-json worker closes partial stream instead of publishing non-prefix final text', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('working draft', 'jsonl');
      return {
        content: 'done',
        reasoningContent: null,
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: null,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 1,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ includePartialMessages: true }),
    lines: lines([userEvent('turn-a', 'partial prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const textDeltas = events
    .filter((event) => event.type === 'stream_event' && event.event?.delta?.type === 'text_delta')
    .map((event) => event.event.delta.text);
  assert.deepEqual(textDeltas, ['working draft']);
  assert.equal(events.some((event) => event.type === 'stream_event' && event.event?.type === 'message_stop'), true);
  assert.equal(events.at(-1)?.type, 'result');
  assert.equal(events.at(-1)?.result, 'done');
});

test('stream-json worker closes started partial stream after non-prefix reasoning failure', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateReasoning?.('first draft');
      request.onIntermediateReasoning?.('replacement');
      return {
        content: 'done',
        reasoningContent: 'replacement',
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: null,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 0,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ includePartialMessages: true }),
    lines: lines([userEvent('turn-a', 'partial prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const streamTypes = events
    .filter((event) => event.type === 'stream_event')
    .map((event) => event.event?.type);

  assert.equal(streamTypes.includes('content_block_stop'), true);
  assert.equal(streamTypes.includes('message_stop'), true);
  assert.equal(events.at(-1)?.type, 'result');
  assert.equal(events.at(-1)?.result, 'done');
});

test('stream-json worker emits WorkerBridge background assistant events', async () => {
  const bridge = new FakeBridge((request) => {
    request.onBackgroundAssistantText?.('background done');
  });
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const backgroundUser = events.find((event) => event.type === 'user' && event.origin?.kind === 'task-notification');
  const backgroundAssistant = events.find((event) => event.type === 'assistant' && event.message?.content?.[0]?.text === 'background done');
  assert.equal(backgroundUser?.session_id, SESSION_ID);
  assert.equal(backgroundAssistant?.session_id, SESSION_ID);
});

test('stream-json worker preserves result order after background assistant output without timing padding', async () => {
  const bridge = new FakeBridge((request) => {
    request.onIntermediateText?.('worker final', 'jsonl');
    request.onBackgroundAssistantText?.('background done');
  }, null, false);
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const backgroundAssistantIndex = events.findIndex((event) =>
    event.type === 'assistant' && event.message?.content?.[0]?.text === 'background done'
  );
  const resultIndex = events.findIndex((event) => event.type === 'result');

  assert.equal(backgroundAssistantIndex >= 0, true);
  assert.equal(resultIndex > backgroundAssistantIndex, true);
});

test('stream-json worker forwards abort signal to WorkerBridge and still shuts down', async () => {
  const controller = new AbortController();
  const bridge = new FakeBridge();
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    signal: controller.signal,
    write: () => undefined,
  });

  assert.equal(bridge.requests[0]?.signal, controller.signal);
  assert.equal(bridge.shutdownCount, 1);
});

test('stream-json worker keeps the primary turn error when shutdown also fails', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn() {
      throw new Error('turn failed');
    },
    async shutdown() {
      throw new Error('shutdown failed');
    },
  };
  const state = await stateContext('/work/open-p');

  await assert.rejects(
    () => runStreamJsonWorkerLines({
      options: options(),
      lines: lines([userEvent('turn-a', 'prompt')]),
      bridge,
      ...state,
      outputMetadata: metadata(),
      write: () => undefined,
    }),
    /turn failed/,
  );
});

test('stream-json worker does not save resumable state when the first turn fails', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn() {
      throw new Error('backend preflight failed');
    },
  };
  const state = await stateContext('/work/open-p');

  await assert.rejects(
    () => runStreamJsonWorkerLines({
      options: options(),
      lines: lines([userEvent('turn-a', 'prompt')]),
      bridge,
      ...state,
      outputMetadata: metadata(),
      write: () => undefined,
    }),
    /backend preflight failed/,
  );

  assert.equal(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker does not emit terminal success when state save fails', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await assert.rejects(
    () => runStreamJsonWorkerLines({
      options: options(),
      lines: lines([userEvent('turn-a', 'prompt')]),
      bridge,
      ...state,
      stateStore: {
        load: state.stateStore.load.bind(state.stateStore),
        requireCompatible: state.stateStore.requireCompatible.bind(state.stateStore),
        save: async () => {
          throw new Error('state save failed');
        },
      } as unknown as SessionStateStore,
      outputMetadata: metadata(),
      write: (chunk) => output.push(chunk),
    }),
    /state save failed/,
  );

  const eventTypes = parseEvents(output.join('')).map((event) => event.type);
  assert.deepEqual(eventTypes, ['system', 'assistant', 'assistant']);
  assert.equal(eventTypes.includes('result'), false);
});

test('stream-json worker rejects prompt args before writing system init', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await assert.rejects(
    () => runStreamJsonWorkerLines({
      options: options({ promptArg: 'not allowed' }),
      lines: lines([userEvent('turn-a', 'prompt')]),
      bridge,
      ...state,
      outputMetadata: metadata(),
      write: (chunk) => output.push(chunk),
    }),
    /--input-format stream-json does not accept prompt arguments/,
  );

  assert.equal(output.join(''), '');
  assert.equal(bridge.requests.length, 0);
});

test('stream-json worker rejects malformed input before acquiring a session lock', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');
  let lockAcquireCount = 0;

  await assert.rejects(
    () => runStreamJsonWorkerLines({
      options: options(),
      lines: lines(['not json']),
      bridge,
      ...state,
      lockStore: {
        acquire: async () => {
          lockAcquireCount += 1;
          throw new Error('lock should not be acquired');
        },
      } as unknown as SessionLockStore,
      outputMetadata: metadata(),
      write: (chunk) => output.push(chunk),
    }),
    /invalid stream-json input line 1/,
  );

  assert.equal(lockAcquireCount, 0);
  assert.equal(output.join(''), '');
  assert.equal(bridge.requests.length, 0);
});

test('stream-json worker rejects concurrent use of the same session lock', async () => {
  const bridge = new FakeBridge();
  const state = await stateContext('/work/open-p');
  const lock = await state.lockStore.acquire(SESSION_ID);
  try {
    await assert.rejects(
      () => runStreamJsonWorkerLines({
        options: options(),
        lines: lines([userEvent('turn-a', 'prompt')]),
        bridge,
        ...state,
        outputMetadata: metadata(),
        write: () => undefined,
      }),
      /session .* is busy/,
    );
  } finally {
    await lock.release();
  }
  assert.equal(bridge.requests.length, 0);
});

test('stream-json worker rejects resume state from a different workspace', async () => {
  const bridge = new FakeBridge();
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-stream-state-'));
  const originalStateStore = new SessionStateStore('/work/original', stateRoot);
  await saveCompatibleState(originalStateStore, '/work/original', 'turn-old');
  const state = {
    projectRoot: '/work/other',
    stateStore: new SessionStateStore('/work/other', stateRoot),
    lockStore: new SessionLockStore('/work/other', stateRoot),
    resolveSessionLogPath: async () => null,
  };

  await assert.rejects(
    () => runStreamJsonWorkerLines({
      options: options({ resume: true }),
      lines: lines([userEvent('turn-a', 'prompt')]),
      bridge,
      ...state,
      outputMetadata: metadata(),
      write: () => undefined,
    }),
    /belongs to a different workspace/,
  );
  assert.equal(bridge.requests.length, 0);
});

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    backend: 'claude-code',
    provider: 'tmux',
    backendSessionId: SESSION_ID,
    resume: false,
    timeoutMs: 120000,
    inputFormat: 'stream-json',
    outputFormat: 'stream-json',
    debugLog: null,
    model: 'claude-test',
    permissionMode: 'bypassPermissions',
    appendSystemPrompt: null,
    jsonSchema: null,
    includePartialMessages: false,
    backendArgs: [],
    promptArg: null,
    turnId: 'fallback-turn',
    ...overrides,
  };
}

function metadata() {
  return {
    cwd: '/work/open-p',
    model: 'claude-test',
    permissionMode: 'bypassPermissions',
    mcpServers: [],
    contextWindow: 200000,
  };
}

async function stateContext(projectRoot: string): Promise<{
  readonly projectRoot: string;
  readonly stateStore: SessionStateStore;
  readonly lockStore: SessionLockStore;
  readonly resolveSessionLogPath: () => Promise<string | null>;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-stream-state-'));
  return {
    projectRoot,
    stateStore: new SessionStateStore(projectRoot, stateRoot),
    lockStore: new SessionLockStore(projectRoot, stateRoot),
    resolveSessionLogPath: async () => null,
  };
}

async function saveCompatibleState(
  stateStore: SessionStateStore,
  projectRoot: string,
  lastTurnId: string | null,
): Promise<void> {
  await stateStore.save({
    backend: 'claude-code',
    provider: 'tmux',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId,
  });
}

async function* lines(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

function userEvent(turnId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    turnId,
    message: {
      role: 'user',
      content,
    },
  });
}

function parseEvents(output: string): Array<Record<string, any>> {
  return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function requiredOpenPEventTypesFromClaudeP(eventTypes: readonly string[]): string[] {
  return eventTypes.filter((type) => type !== 'rate_limit_event');
}

function assertNoOpenPOnlyFields(event: Record<string, unknown>): void {
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'turnId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'diagnostics'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'text'), false);
}
