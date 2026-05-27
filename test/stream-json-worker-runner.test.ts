import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runStreamJsonWorkerLines, type StreamJsonWorkerBridge } from '../src/core/stream-json-worker-runner.js';
import type { ResolvedCliOptions } from '../src/core/cli-args.js';
import { SessionLockStore } from '../src/core/session-lock.js';
import { SessionStateStore } from '../src/core/session-state.js';
import { parseStreamJsonLines } from '../src/core/stream-json-parser.js';
import type { AssistantEventSnapshot } from '../src/core/types.js';
import type { WorkerTurnRequest, WorkerTurnResult } from '../src/core/worker-types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

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

class DeferredCompletionBridge implements StreamJsonWorkerBridge {
  readonly requests: WorkerTurnRequest[] = [];
  shutdownCount = 0;
  private readonly completionReleased: Promise<void>;
  private releaseCompletion: (() => void) | null = null;

  constructor(
    private readonly streamedText = 'backend-neutral stream',
    private readonly completedSessionId = SESSION_ID,
  ) {
    this.completionReleased = new Promise<void>((resolve) => {
      this.releaseCompletion = resolve;
    });
  }

  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    this.requests.push(request);
    request.onIntermediateText?.(this.streamedText, 'jsonl');
    await this.completionReleased;
    return {
      content: this.streamedText,
      reasoningContent: null,
      sessionId: this.completedSessionId,
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
        intermediateTextCount: 1,
      },
    };
  }

  release(): void {
    this.releaseCompletion?.();
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
  assert.equal(bridge.requests[0]?.sessionId, null);
  assert.equal(bridge.requests[1]?.sessionId, SESSION_ID);
  assert.equal(bridge.requests[0]?.projectRoot, '/work/open-p');
  assert.equal(bridge.requests[0]?.contextWindow, 200000);
  assert.equal(bridge.requests[0]?.reasoningEffort, null);
  assert.deepEqual(bridge.requests[0]?.binArgs, []);
  const binArgs = [...(bridge.requests[0]?.binArgs ?? [])] as string[];
  assert.equal(binArgs.includes('-p'), false);
  assert.equal(binArgs.includes('--print'), false);

  const events = parseEvents(output.join(''));
  assert.deepEqual(events.map((event) => event.openp.form), [
    'result',
    'result',
  ]);
  assert.equal(events[0]?.openp.sessionId, SESSION_ID);
  assert.equal(resultAnswerText(events[0]?.openp ?? {}), 'worker final');
  assert.equal(resultAnswerText(events[1]?.openp ?? {}), 'worker final');
  assert.deepEqual(resultAnswerTexts(events[0]?.openp ?? {}), ['worker final']);
  assert.deepEqual(resultAnswerTexts(events[1]?.openp ?? {}), ['worker final']);
  for (const event of events) {
    assertNoOpenPOnlyFields(event);
  }
});

test('stream-json worker forwards public reasoning effort to WorkerBridge', async () => {
  const bridge = new FakeBridge();
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ reasoningEffort: 'high' }),
    lines: lines([userEvent('turn-a', 'prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: () => undefined,
  });

  assert.equal(bridge.requests[0]?.reasoningEffort, 'high');
  assert.deepEqual(bridge.requests[0]?.binArgs, []);
});

test('stream-json worker forwards public tool allowlist to WorkerBridge', async () => {
  const bridge = new FakeBridge();
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ tools: 'Read,Grep' }),
    lines: lines([userEvent('turn-a', 'prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: () => undefined,
  });

  assert.equal(bridge.requests[0]?.tools, 'Read,Grep');
  assert.deepEqual(bridge.requests[0]?.binArgs, []);
});

test('stream-json worker emits result-only non-streaming stream-json order', async () => {
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
    events.map((event) => event.openp?.form),
    ['result'],
  );
  const resultIndex = events.findIndex((event) => event.openp?.form === 'result');
  assertNoTopLevelResultFormEvents(events);
  assert.equal(events.every((event) => event.openp?.form === 'result'), true);
  assert.equal(resultIndex, 0);
  assert.deepEqual(terminalAssistantTexts(events), ['worker final']);
});

test('stream-json worker emits result assistant only inside the terminal turn result', async () => {
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
  const resultIndex = events.findIndex((event) => event.openp?.form === 'result');

  assertNoTopLevelResultFormEvents(events);
  assert.equal(events.slice(0, resultIndex).some((event) => event.openp?.form === 'streaming'), false);
  assert.deepEqual(terminalAssistantTexts(events), ['worker final']);
  assert.equal(resultIndex, 0);
});

test('stream-json worker suppresses assistant stdout before backend turn completion without streaming opt-in', async () => {
  const NATIVE_SESSION_ID = '22222222-2222-4222-8222-222222222222';
  const bridge = new DeferredCompletionBridge('backend-neutral stream', NATIVE_SESSION_ID);
  const output: string[] = [];
  const state = await stateContext('/work/open-p');
  const runPromise = runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  try {
    await waitUntil(() => bridge.requests.length > 0);
    const eventsBeforeCompletion = parseEvents(output.join(''));
    assert.equal(eventsBeforeCompletion.some((event) => event.openp?.form === 'streaming'), false);
    assert.equal(eventsBeforeCompletion.some((event) => event.openp?.form === 'result'), false);
  } catch (error) {
    bridge.release();
    await runPromise.catch(() => undefined);
    throw error;
  }

  bridge.release();
  const code = await runPromise;
  const events = parseEvents(output.join(''));
  const resultIndex = events.findIndex((event) => event.openp?.form === 'result');

  assert.equal(code, 0);
  assertNoTopLevelResultFormEvents(events);
  assert.equal(events.some((event) => event.openp?.form === 'streaming'), false);
  assert.ok(resultIndex >= 0);
  assert.equal(events[resultIndex]?.openp.sessionId, NATIVE_SESSION_ID);
  assert.equal(resultAnswerText(events[resultIndex]?.openp ?? {}), 'backend-neutral stream');
  assert.deepEqual(terminalAssistantTexts(events), ['backend-neutral stream']);
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
  const resultIndex = events.findIndex((event) => event.openp?.form === 'result');

  assertNoTopLevelResultFormEvents(events);
  assert.equal(events.every((event) => event.openp?.form === 'result'), true);
  assert.equal(resultIndex, events.length - 1);
  assert.deepEqual(terminalAssistantTexts(events), ['worker final']);
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
  const resultIndex = events.findIndex((event) => event.openp?.form === 'result');

  assertNoTopLevelResultFormEvents(events);
  assert.equal(events.every((event) => event.openp?.form === 'result'), true);
  assert.equal(resultIndex, events.length - 1);
  assert.deepEqual(terminalAssistantTexts(events), ['worker final']);
});

test('stream-json worker parser keeps result assistant output out of intermediate callbacks', async () => {
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

  assert.deepEqual(parsedIntermediate, []);
  assert.equal(result?.content, 'worker final');
  assert.equal(result?.diagnostics.inputTokens, 10);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.stopReason, 'end_turn');
});

test('stream-json worker parser keeps preserved result snapshots out of intermediate callbacks', async () => {
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
        stop_reason: 'end_turn',
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
  assert.deepEqual(events.map((event) => event.openp?.form), ['result']);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['worker final']);

  const result = parseStreamJsonLines(output.join('').trim().split('\n'), {
    onIntermediateText: (text) => parsedIntermediate.push(text),
  });

  assert.deepEqual(parsedIntermediate, []);
  assert.equal(result?.content, 'worker final');
  assert.equal(result?.diagnostics.inputTokens, 10);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.stopReason, 'end_turn');
});

test('stream-json worker does not repeat a streamed result text snapshot', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    [{
      message: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'worker final' }],
        stop_reason: 'end_turn',
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
  assert.deepEqual(events.map((event) => event.openp?.form), ['result']);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['worker final']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'worker final');
});

test('stream-json worker preserves non-result text snapshots without streaming opt-in', async () => {
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
          stop_reason: 'end_turn',
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
  assert.deepEqual(events.map((event) => event.openp.form), ['result']);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(resultAnswerTexts(terminalOpenP(events)), ['worker', 'worker final']);
});

test('stream-json worker preserves result reasoning when suppressing duplicate streamed text', async () => {
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
  const terminalResult = terminalOpenP(events);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(resultReasoningTexts(terminalResult), ['thinking done']);
  assert.deepEqual(resultAnswerTexts(terminalResult), ['worker final']);
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
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['first draft']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'first draft');
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
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['first draft']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'first draft');
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
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['correct final']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'correct final');
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
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['Hello world']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'Hello world');
});

test('stream-json worker suppresses raw result assistant when screen preview matches rendered markdown', async () => {
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
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['## Title body']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), '## Title body');
});

test('stream-json worker preserves non-result reasoning snapshots without streaming opt-in', async () => {
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
          stop_reason: 'end_turn',
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
  const terminalResult = terminalOpenP(events);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(resultReasoningTexts(terminalResult), ['thinking snapshot']);
  assert.deepEqual(resultAnswerTexts(terminalResult), ['worker final']);
});

test('stream-json worker ignores intermediate reasoning callbacks without streaming opt-in', async () => {
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
          stop_reason: 'end_turn',
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
  const terminalResult = terminalOpenP(events);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(resultReasoningTexts(terminalResult), ['thinking live']);
  assert.deepEqual(resultAnswerTexts(terminalResult), ['worker final']);
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

test('stream-json worker emits streaming snapshots from live WorkerBridge updates', async () => {
  const bridge = new FakeBridge();
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingAnswerTexts(events), ['worker', 'worker final']);
  assert.ok(events.some((event) => event.openp?.form === 'streaming' && typeof event.openp?.output?.answer === 'string'));
  assert.equal(events.at(-1)?.openp.form, 'result');
  for (const event of events) {
    assertNoOpenPOnlyFields(event);
  }
});

test('stream-json worker emits backend-owned live text while json schema result is active', async () => {
  const snapshot: AssistantEventSnapshot = {
    semanticKind: 'commentary',
    message: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'schema progress' }],
      stop_reason: 'end_turn',
    },
  };
  let callbackWasAvailable = false;
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      callbackWasAvailable = typeof request.onIntermediateAssistantSnapshot === 'function';
      request.onIntermediateText?.('schema progress', 'jsonl');
      request.onIntermediateAssistantSnapshot?.(snapshot, 'jsonl');
      return {
        content: '{"ok":true}',
        reasoningContent: null,
        structuredOutput: { ok: true },
        assistantEvents: [snapshot],
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
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
          intermediateTextCount: 0,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({
      streaming: true,
      jsonSchema: '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}',
    }),
    lines: lines([userEvent('turn-a', 'schema prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  assert.equal(callbackWasAvailable, true);
  const events = parseEvents(output.join(''));
  assert.equal(streamingAnswerTexts(events).includes('schema progress'), true);
  for (const event of events.filter((item) => item.openp?.form === 'streaming')) {
    assert.equal(event.openp?.structuredOutput, null);
  }
  assert.deepEqual(terminalOpenP(events).structuredOutput, { ok: true });
});

test('stream-json worker streaming text snapshots accumulate to result assistant and result text', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    undefined,
    ['A', 'AB', 'ABC'],
    'ABC',
  );
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingAnswerTexts(events), ['A', 'AB', 'ABC']);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['ABC']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'ABC');
});

test('stream-json worker preserves newlines in streaming text snapshots and result text', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    undefined,
    ['line 1\nline 2', 'line 1\nline 2\nline 3'],
    'line 1\nline 2\nline 3',
  );
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingAnswerTexts(events), ['line 1\nline 2', 'line 1\nline 2\nline 3']);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['line 1\nline 2\nline 3']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'line 1\nline 2\nline 3');
});

test('stream-json worker does not backfill result answer tail into streaming snapshot', async () => {
  const bridge = new FakeBridge(
    undefined,
    null,
    true,
    undefined,
    ['A', 'AB'],
    'ABC',
  );
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingAnswerTexts(events), ['A', 'AB']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'ABC');
});

test('stream-json worker excludes screen-sourced text from public streaming events', async () => {
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
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  assert.deepEqual(streamingAnswerTexts(parseEvents(output.join(''))), ['jsonl progress']);
});

test('stream-json worker excludes screen-sourced text from result assistant preview events', async () => {
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

  const events = parseEvents(output.join(''));
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['jsonl progress']);
});

test('stream-json worker publishes JSONL assistant snapshot text and ignores prior screen preview', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('jsonl', 'screen');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
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

  const events = parseEvents(output.join(''));
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['jsonl progress']);
});

test('stream-json worker emits backend-owned reasoning before answer when snapshots are preserved', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateReasoning?.('thinking', 'jsonl');
      request.onIntermediateText?.('answer', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking' },
            { type: 'text', text: 'answer' },
          ],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'answer',
        reasoningContent: 'thinking',
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
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const streamingEvents = events.filter((event) => event.openp?.form === 'streaming');

  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingOutputKeys(events), [
    'reasoning',
    'answer',
  ]);
  assert.deepEqual(streamingReasoningTexts(events), ['thinking']);
  assert.deepEqual(streamingAnswerTexts(events), ['answer']);
  assert.deepEqual(terminalAssistantTexts(events), ['answer']);
});

test('stream-json worker emits backend-owned JSONL text before backend completion with streaming opt-in', async () => {
  let releaseCompletion!: () => void;
  const completionReleased = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('checking files...', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_progress',
          content: [{ type: 'text', text: 'checking files...' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      await completionReleased;
      return {
        content: 'result answer',
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
  const runPromise = runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  try {
    await waitUntil(() => parseEvents(output.join('')).some((event) =>
      event.openp?.form === 'streaming' &&
      event.openp.scope === 'active' &&
      event.openp.output?.answer === 'checking files...',
    ));
    const eventsBeforeCompletion = parseEvents(output.join(''));
    assert.equal(eventsBeforeCompletion.some((event) => event.openp?.form === 'result'), false);
  } catch (error) {
    releaseCompletion();
    await runPromise.catch(() => undefined);
    throw error;
  }

  releaseCompletion();
  const code = await runPromise;
  const events = parseEvents(output.join(''));
  const assistantTexts = streamingAnswerTexts(events);

  assert.equal(code, 0);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(assistantTexts, ['checking files...']);
  assert.deepEqual(terminalAssistantTexts(events), ['result answer']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'result answer');
});

test('stream-json worker serializes backend-owned active streaming answer as turn-cumulative text', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('checking files...', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_progress_a',
          content: [{ type: 'text', text: 'checking files...' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      request.onIntermediateText?.('checking files...\n\nfound the file.', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_progress_b',
          content: [{ type: 'text', text: 'found the file.' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'result answer',
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
          intermediateTextCount: 2,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingAnswerTexts(events), [
    'checking files...',
    'checking files...\n\nfound the file.',
  ]);
});

test('stream-json worker does not infer prefix-like assistant snapshots and serializes backend-owned text', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('A', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_prefix_a',
          content: [{ type: 'text', text: 'A' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      request.onIntermediateText?.('A\n\nAB', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_prefix_ab',
          content: [{ type: 'text', text: 'AB' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'result answer',
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
          intermediateTextCount: 2,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingAnswerTexts(events), ['A', 'A\n\nAB']);
});

test('stream-json worker does not infer active streaming answer from semantic assistant snapshots', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_commentary',
          content: [{ type: 'text', text: 'backend did not publish this as text' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'result answer',
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
          intermediateTextCount: 0,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingAnswerTexts(events), []);
  assert.equal(resultAnswerText(terminalOpenP(events)), 'result answer');
});

test('stream-json worker does not re-accumulate non-semantic assistant snapshots after backend text streaming', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('A', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_same',
          content: [{ type: 'text', text: 'A' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      request.onIntermediateText?.('AB', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_same',
          content: [{ type: 'text', text: 'AB' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'result answer',
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
          intermediateTextCount: 2,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingAnswerTexts(events), ['A', 'AB']);
});

test('stream-json worker emits active streaming answer as turn-cumulative text when final JSONL text follows a snapshot', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('checking files...', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_progress',
          content: [{ type: 'text', text: 'checking files...' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_tool',
          content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file: 'sample.txt' } }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      request.onIntermediateText?.('checking files...\n\nresult answer', 'jsonl');
      return {
        content: 'result answer',
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
          toolsUsed: ['Read'],
          autoCompacted: null,
          intermediateTextCount: 2,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingAnswerTexts(events), [
    'checking files...',
    'checking files...\n\nresult answer',
  ]);
  assert.ok(events.some((event) =>
    event.openp?.form === 'streaming' &&
    event.openp?.output &&
    typeof event.openp.output === 'object' &&
    !Array.isArray(event.openp.output) &&
    event.openp.output.toolCall
  ));
});

test('stream-json worker keeps result assistant event when live snapshot matches result text', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('same answer', 'jsonl');
      request.onIntermediateAssistantSnapshot?.({
        semanticKind: 'commentary',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_progress',
          content: [{ type: 'text', text: 'same answer' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      }, 'jsonl');
      return {
        content: 'same answer',
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

  const code = await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'stream prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });
  const events = parseEvents(output.join(''));
  const assistantTexts = events
    .filter((event) => event.openp?.form === 'streaming')
    .map((event) => event.openp?.output?.answer);
  const assistantOpenPEvents = events
    .filter((event) => event.openp?.form === 'streaming')
    .map((event) => event.openp);
  const terminalResult = terminalOpenP(events);

  assert.equal(code, 0);
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(assistantTexts, ['same answer']);
  assert.equal(assistantOpenPEvents[0]?.form, 'streaming');
  assert.equal(assistantOpenPEvents[0]?.output?.answer, 'same answer');
  assert.deepEqual(resultAnswerTexts(terminalResult), ['same answer']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'same answer');
  assert.deepEqual(events.at(-1)?.openp?.output?.answer, ['same answer']);
});

test('stream-json worker uses JSONL snapshot when screen preview matches result markdown', async () => {
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
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['## Title']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), '## Title');
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
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(terminalAssistantTexts(events), ['replacement from jsonl']);
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'replacement from jsonl');
});

test('stream-json worker does not complete streaming reasoning from result', async () => {
  const bridge = new FakeBridge((request) => {
    request.onIntermediateReasoning?.('think');
  }, 'thinking done', false);
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingReasoningTexts(events), ['think']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'worker final');
});

test('stream-json worker keeps result and logs streaming reasoning outside result reasoning', async () => {
  const bridge = new FakeBridge((request) => {
    request.onIntermediateReasoning?.('first draft');
  }, 'replacement', false);
  const output: string[] = [];
  const state = await stateContext('/work/open-p');
  const debugLogPath = join(await mkdtemp(join(tmpdir(), 'openp-debug-')), 'debug.jsonl');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true, debugLog: debugLogPath }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const reasoningSnapshots = streamingReasoningTexts(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');
  assert.deepEqual(reasoningSnapshots, ['first draft']);
  assert.equal(resultAnswerText(terminalOpenP(events)), 'worker final');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-reasoning-outside-result');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker emits live reasoning after answer text streaming starts', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateReasoning?.('think');
      request.onIntermediateText?.('answer', 'jsonl');
      request.onIntermediateReasoning?.('think\n\nlater reasoning');
      return {
        content: 'answer',
        reasoningContent: 'later reasoning',
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
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingReasoningTexts(events), ['think', 'think\n\nlater reasoning']);
  assert.deepEqual(streamingAnswerTexts(events), ['answer']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'answer');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker does not synthesize result-only reasoning into streaming output', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('answer', 'jsonl');
      return {
        content: 'answer',
        reasoningContent: 'thinking',
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
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.deepEqual(streamingReasoningTexts(events), []);
  assert.deepEqual(streamingAnswerTexts(events), ['answer']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(resultAnswerText(events.at(-1)?.openp ?? {}), 'answer');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker keeps result and logs streaming answer outside replacement result', async () => {
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
  const debugLogPath = join(await mkdtemp(join(tmpdir(), 'openp-debug-')), 'debug.jsonl');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true, debugLog: debugLogPath }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const streamingTexts = streamingAnswerTexts(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');
  assert.deepEqual(streamingTexts, ['working draft']);
  assert.equal(resultAnswerText(terminalOpenP(events)), 'done');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker does not surface streaming-result diagnostic diagnostics without debug log', async () => {
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
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.equal(resultAnswerText(terminalOpenP(events)), 'done');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker surfaces streaming result diagnostics as warnings only in verbose mode', async () => {
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
  const debugLogPath = join(await mkdtemp(join(tmpdir(), 'openp-debug-')), 'debug.jsonl');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true, verbose: true, debugLog: debugLogPath }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const result = terminalOpenP(events);
  assert.equal(resultAnswerText(result), 'done');
  assert.deepEqual(resultWarnings(result), [{
    severity: 'warning',
    code: 'streaming_result_diagnostic',
    message: `Streaming result diagnostics were recorded (1); result was preserved. See debug log: ${debugLogPath}.`,
  }]);
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker verbose warning does not claim recording without debug log', async () => {
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
    options: options({ streaming: true, verbose: true }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const result = terminalOpenP(events);
  assert.equal(resultAnswerText(result), 'done');
  assert.deepEqual(resultWarnings(result), [{
    severity: 'warning',
    code: 'streaming_result_diagnostic',
    message: 'Streaming result diagnostics were detected (1); result was preserved. Use --debug-log to record details.',
  }]);
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker keeps result and logs cumulative intermediate text outside result', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateText?.('first progress', 'jsonl');
      request.onIntermediateText?.('first progress\n\nsecond progress', 'jsonl');
      return {
        content: 'result answer',
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
          intermediateTextCount: 2,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');
  const debugLogPath = join(await mkdtemp(join(tmpdir(), 'openp-debug-')), 'debug.jsonl');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true, debugLog: debugLogPath }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const streamingTexts = streamingAnswerTexts(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.deepEqual(streamingTexts, ['first progress', 'first progress\n\nsecond progress']);
  assert.equal(resultAnswerText(terminalOpenP(events)), 'result answer');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker keeps result and logs streamed reasoning/text when text streaming snapshot is outside result', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateReasoning?.('thinking');
      request.onIntermediateText?.('draft', 'jsonl');
      request.onIntermediateText?.('draft\n\nanswer', 'jsonl');
      return {
        content: 'answer',
        reasoningContent: 'thinking',
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
          intermediateTextCount: 2,
        },
      };
    },
  };
  const output: string[] = [];
  const state = await stateContext('/work/open-p');
  const debugLogPath = join(await mkdtemp(join(tmpdir(), 'openp-debug-')), 'debug.jsonl');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true, debugLog: debugLogPath }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const reasoningSnapshots = streamingReasoningTexts(events);
  const streamingTexts = streamingAnswerTexts(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.deepEqual(reasoningSnapshots, ['thinking']);
  assert.deepEqual(streamingTexts, ['draft', 'draft\n\nanswer']);
  assert.equal(resultAnswerText(terminalOpenP(events)), 'answer');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
});

test('stream-json worker keeps result and logs cumulative streaming reasoning mismatch', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      request.onIntermediateReasoning?.('first draft');
      request.onIntermediateReasoning?.('first draft\n\nreplacement');
      request.onIntermediateText?.('done', 'jsonl');
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
  const debugLogPath = join(await mkdtemp(join(tmpdir(), 'openp-debug-')), 'debug.jsonl');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true, debugLog: debugLogPath }),
    lines: lines([userEvent('turn-a', 'streaming prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenP(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingReasoningTexts(events), ['first draft', 'first draft\n\nreplacement']);
  assert.deepEqual(streamingTexts, ['done']);
  assert.deepEqual(resultReasoningTexts(terminalResult), ['replacement']);
  assert.equal(resultAnswerText(terminalResult), 'done');
  assert.equal(diagnostic?.issues?.[0]?.event, 'streaming_result_mismatch');
  assert.notEqual(await state.stateStore.load(SESSION_ID), null);
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
  const backgroundAssistant = events.find((event) =>
    event.openp?.form === 'streaming' &&
    event.openp.scope === 'background' &&
    event.openp.output?.answer === 'background done'
  );
  assert.ok(backgroundAssistant);
  assert.deepEqual(Object.keys(backgroundAssistant), ['openp']);
  assert.equal(Object.prototype.hasOwnProperty.call(backgroundAssistant, 'session_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(backgroundAssistant.openp, 'session_id'), false);
});

test('stream-json worker keeps background assistant snapshots out of active streaming and result', async () => {
  const backgroundSnapshot: AssistantEventSnapshot = {
    semanticKind: 'background',
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
  const bridge = new FakeBridge((request) => {
    request.onIntermediateAssistantSnapshot?.(backgroundSnapshot, 'jsonl');
  }, null, false, undefined, [], 'active result');
  const output: string[] = [];
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options({ streaming: true }),
    lines: lines([userEvent('turn-a', 'prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  const openpEvents = events.map((event) => event.openp);
  const activeStreamingAnswers = openpEvents
    .filter((openp) => openp.form === 'streaming' && openp.scope === 'active')
    .map((openp) => openp.output?.answer)
    .filter((text): text is string => typeof text === 'string');
  const backgroundStreaming = openpEvents.find((openp) => openp.form === 'streaming' && openp.scope === 'background');
  const terminal = terminalOpenP(events);

  assert.deepEqual(activeStreamingAnswers, []);
  assert.deepEqual(backgroundStreaming?.output, { answer: 'background done' });
  assert.deepEqual(terminal.output.answer, ['active result']);
  assert.deepEqual(terminal.output.toolCall, []);
  assert.deepEqual(terminal.output.toolResult, []);
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
    event.openp?.form === 'streaming' &&
    event.openp.scope === 'background' &&
    event.openp.output?.answer === 'background done'
  );
  const resultIndex = events.findIndex((event) => event.openp?.form === 'result');

  assert.equal(backgroundAssistantIndex >= 0, true);
  assert.equal(resultIndex > backgroundAssistantIndex, true);
});

test('stream-json worker forwards abort signal to WorkerBridge and still shuts down', async () => {
  const controller = new AbortController();
  const forceController = new AbortController();
  const killController = new AbortController();
  const bridge = new FakeBridge();
  const state = await stateContext('/work/open-p');

  await runStreamJsonWorkerLines({
    options: options(),
    lines: lines([userEvent('turn-a', 'prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    signal: controller.signal,
    forceSignal: forceController.signal,
    killSignal: killController.signal,
    write: () => undefined,
  });

  assert.equal(bridge.requests[0]?.signal, controller.signal);
  assert.equal(bridge.requests[0]?.forceSignal, forceController.signal);
  assert.equal(bridge.requests[0]?.killSignal, killController.signal);
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

  const eventTypes = parseEvents(output.join('')).map((event) => event.openp?.form);
  assert.deepEqual(eventTypes, []);
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

test('stream-json worker rejects a different returned session id on resume', async () => {
  const bridge: StreamJsonWorkerBridge = {
    async runTurn() {
      return {
        content: 'wrong session',
        reasoningContent: null,
        sessionId: '22222222-2222-4222-8222-222222222222',
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
  const state = await stateContext('/work/open-p');
  await saveCompatibleState(state.stateStore, '/work/open-p', 'turn-old');

  await assert.rejects(
    () => runStreamJsonWorkerLines({
      options: options({ resume: true }),
      lines: lines([userEvent('turn-a', 'prompt')]),
      bridge,
      ...state,
      outputMetadata: metadata(),
      write: () => undefined,
    }),
    /different session id/,
  );
});

test('stream-json worker forwards provider-native session id to subsequent turns', async () => {
  const NATIVE_SESSION_ID = '22222222-2222-4222-8222-222222222222';
  const requestSessionIds: (string | null)[] = [];
  let callCount = 0;
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      requestSessionIds.push(request.sessionId);
      callCount += 1;
      return {
        content: callCount === 1 ? 'first' : 'second',
        reasoningContent: null,
        sessionId: callCount === 1 ? NATIVE_SESSION_ID : request.sessionId ?? 'missing-resume-session',
        diagnostics: {
          numTurns: callCount,
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: 25,
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
    lines: lines([
      userEvent('turn-a', 'first prompt'),
      userEvent('turn-b', 'second prompt'),
    ]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  assert.equal(requestSessionIds[0], null);
  assert.equal(requestSessionIds[1], NATIVE_SESSION_ID);
});

test('stream-json backend-generated first turn publishes returned session id as canonical', async () => {
  const NATIVE_SESSION_ID = '22222222-2222-4222-8222-222222222222';
  const requestSessionIds: (string | null)[] = [];
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      requestSessionIds.push(request.sessionId);
      request.onIntermediateText?.('working', 'jsonl');
      return {
        content: 'done',
        reasoningContent: null,
        sessionId: NATIVE_SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: 25,
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
    options: options({ backend: 'codex' }),
    lines: lines([userEvent('turn-a', 'first prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.equal(requestSessionIds[0], null);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(events.at(-1)?.openp.sessionId, NATIVE_SESSION_ID);
  assert.equal(await state.stateStore.load(SESSION_ID), null);
  assert.equal((await state.stateStore.load(NATIVE_SESSION_ID))?.backendSessionId, NATIVE_SESSION_ID);
});

test('stream-json first turn omits open-p session id and stores returned backend id', async () => {
  const NATIVE_SESSION_ID = '33333333-3333-4333-8333-333333333333';
  const requestSessionIds: (string | null)[] = [];
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      requestSessionIds.push(request.sessionId);
      request.onIntermediateText?.('working', 'jsonl');
      return {
        content: 'done',
        reasoningContent: null,
        sessionId: NATIVE_SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: 25,
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
    lines: lines([userEvent('turn-a', 'first prompt')]),
    bridge,
    ...state,
    outputMetadata: metadata(),
    write: (chunk) => output.push(chunk),
  });

  const events = parseEvents(output.join(''));
  assert.equal(requestSessionIds[0], null);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(events.at(-1)?.openp.sessionId, NATIVE_SESSION_ID);
  assert.equal(await state.stateStore.load(SESSION_ID), null);
  assert.equal((await state.stateStore.load(NATIVE_SESSION_ID))?.backendSessionId, NATIVE_SESSION_ID);
});

test('stream-json worker ignores saved provider process ids on resume', async () => {
  const PROVIDER_PROCESS_ID = 'pty-provider-process-id';
  const bridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      return {
        content: 'resumed',
        reasoningContent: null,
        sessionId: request.sessionId ?? SESSION_ID,
        diagnostics: {
          numTurns: 1,
          inputTokens: 5,
          outputTokens: 1,
          cacheReadInputTokens: null,
          contextWindow: null,
          lastSubturnContextTokens: null,
          durationMs: 10,
          totalCostUsd: null,
          stopReason: 'end_turn',
          toolsUsed: [],
          autoCompacted: null,
          intermediateTextCount: 0,
        },
      };
    },
  };

  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-stream-state-'));
  const stateStore = new SessionStateStore('/work/open-p', stateRoot);
  await stateStore.save({
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: '/work/open-p',
    lastProviderSessionId: PROVIDER_PROCESS_ID,
    sessionLogPath: null,
    lastTurnId: 'prev-turn',
  });

  const requestSessionIds: (string | null)[] = [];
  const wrappedBridge: StreamJsonWorkerBridge = {
    async runTurn(request) {
      requestSessionIds.push(request.sessionId);
      return bridge.runTurn(request);
    },
  };

  const output: string[] = [];
  await runStreamJsonWorkerLines({
    options: options({ resume: true }),
    lines: lines([userEvent('turn-resume', 'follow up')]),
    bridge: wrappedBridge,
    projectRoot: '/work/open-p',
    stateStore,
    lockStore: new SessionLockStore('/work/open-p', stateRoot),
    outputMetadata: metadata(),
    resolveSessionLogPath: async () => null,
    write: (chunk) => output.push(chunk),
  });

  assert.equal(requestSessionIds[0], SESSION_ID);
});

function options(overrides: Partial<ResolvedCliOptions> = {}): ResolvedCliOptions {
  return {
    backend: 'claude',
    backendSessionId: SESSION_ID,
    resume: false,
    timeoutMs: 120000,
    inputFormat: 'stream-json',
    outputFormat: 'stream-json',
    debugLog: null,
    model: 'claude-test',
    reasoningEffort: null,
    permissionMode: 'danger-full-access',
    tools: null,
    jsonSchema: null,
    streaming: false,
    verbose: false,
    backendArgs: [],
    promptArg: null,
    turnId: 'fallback-turn',
    ...overrides,
  };
}

function metadata() {
  return {
    backend: 'claude',
    cwd: '/work/open-p',
    model: 'claude-test',
    permissionMode: 'danger-full-access',
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
    backend: 'claude',
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
  return output.trim().split('\n').filter(Boolean).map(parseOutputLine);
}

function parseOutputLine(line: string): Record<string, any> {
  const event = JSON.parse(line) as Record<string, any>;
  const openp = event.openp;
  assert.deepEqual(Object.keys(event), ['openp']);
  assert.ok(openp && typeof openp === 'object' && !Array.isArray(openp));
  assertNoStreamingAssistantTextAliases(openp);
  return event;
}

function assertNoStreamingAssistantTextAliases(openp: Record<string, any>): void {
  const output = openp.output && typeof openp.output === 'object' && !Array.isArray(openp.output)
    ? openp.output as Record<string, unknown>
    : {};
  assert.ok(openp.form === 'streaming' || openp.form === 'result');
  assert.ok(openp.scope === 'active' || openp.scope === 'background');
  for (const field of ['type', 'kind', 'text', 'textDelta', 'answerText', 'answers', 'reasoningText', 'reasoning', 'toolCalls', 'toolResults', 'assistant.message', 'assistant.event']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(openp, field),
      false,
      `openp must not expose legacy field ${field}`,
    );
  }
  if (openp.form === 'streaming') {
    assert.equal(Object.keys(output).length, 1);
    assert.ok(['answer', 'reasoning', 'toolCall', 'toolResult'].includes(Object.keys(output)[0]!));
  } else {
    assert.deepEqual(Object.keys(output).sort(), ['answer', 'reasoning', 'toolCall', 'toolResult'].sort());
    assert.ok(Array.isArray(output.answer));
    assert.ok(Array.isArray(output.reasoning));
    assert.ok(Array.isArray(output.toolCall));
    assert.ok(Array.isArray(output.toolResult));
  }
  const metadata = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata as Record<string, unknown>
    : {};
  if (Array.isArray(metadata.messageBlocks)) {
    for (const block of metadata.messageBlocks) {
      assertNeutralOpenPMetadataBlock(block);
    }
  }
}

function assertNeutralOpenPMetadataBlock(block: unknown): void {
  assert.ok(block && typeof block === 'object' && !Array.isArray(block));
  const item = block as Record<string, unknown>;
  assert.equal(typeof item.type, 'string');
  assert.equal([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'tool_use',
    'server_tool_use',
    'tool_result',
    'output_text',
    'message.partial',
    'message.final',
  ].includes(String(item.type)), false);
  assert.equal(hasOpenPMetadataForbiddenField(item), false);
}

function isForbiddenOpenPMetadataTypeValue(value: string): boolean {
  return new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'tool_use',
    'server_tool_use',
    'tool_result',
    'output_text',
    'message.partial',
    'message.final',
  ]).has(value);
}

function hasOpenPMetadataForbiddenField(value: unknown): boolean {
  const forbiddenFields = new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'input',
    'content',
    'tool_use_id',
    'is_error',
  ]);
  const visit = (item: unknown, nestedDepth: number): boolean => {
    if (Array.isArray(item)) {
      return item.some((nested) => visit(nested, nestedDepth + 1));
    }
    if (!item || typeof item !== 'object') {
      return false;
    }
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
      if (forbiddenFields.has(key)) {
        return true;
      }
      if (
        key === 'type' &&
        typeof nested === 'string' &&
        isForbiddenOpenPMetadataTypeValue(nested)
      ) {
        return true;
      }
      if (visit(nested, nestedDepth + 1)) {
        return true;
      }
    }
    return false;
  };
  return visit(value, 0);
}

function streamingAnswerTexts(events: readonly Record<string, any>[]): string[] {
  return streamingTextsByKind(events, 'answer');
}

function streamingReasoningTexts(events: readonly Record<string, any>[]): string[] {
  return streamingTextsByKind(events, 'reasoning');
}

function streamingTextsByKind(events: readonly Record<string, any>[], kind: string): string[] {
  return events
    .map((event) => event.openp)
    .map((openp) => {
      const output = openp?.output && typeof openp.output === 'object' && !Array.isArray(openp.output)
        ? openp.output as Record<string, unknown>
        : {};
      return openp?.form === 'streaming' && typeof output[kind] === 'string'
        ? output[kind] as string
        : null;
    })
    .filter((text): text is string => typeof text === 'string');
}

function terminalOpenP(events: readonly Record<string, any>[]): Record<string, any> {
  const terminal = events.find((event) => event.openp?.form === 'result')?.openp;
  assert.ok(terminal, 'expected terminal result');
  return terminal;
}

function terminalAssistantTexts(events: readonly Record<string, any>[]): string[] {
  return resultAnswerTexts(terminalOpenP(events));
}

function assertNoTopLevelResultFormEvents(events: readonly Record<string, any>[]): void {
  assert.equal(
    events.slice(0, -1).some((event) => event.openp?.form === 'result'),
    false,
  );
}

function resultAnswerText(openp: Record<string, any>): string {
  return resultAnswerTexts(openp).join('\n\n');
}

function resultAnswerTexts(openp: Record<string, any>): string[] {
  return resultTextArray(openp, 'answer');
}

function resultReasoningTexts(openp: Record<string, any>): string[] {
  return resultTextArray(openp, 'reasoning');
}

function resultWarnings(openp: Record<string, any>): unknown {
  const metadata = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata as Record<string, unknown>
    : {};
  return metadata.warnings;
}

function streamingOutputKeys(events: readonly Record<string, any>[]): string[] {
  return events
    .map((event) => event.openp)
    .filter((openp) => openp?.form === 'streaming')
    .map((openp) => Object.keys(openp.output ?? {})[0])
    .filter((key): key is string => typeof key === 'string');
}

function resultTextArray(openp: Record<string, any>, key: 'answer' | 'reasoning'): string[] {
  const output = openp.output && typeof openp.output === 'object' && !Array.isArray(openp.output)
    ? openp.output as Record<string, unknown>
    : {};
  return ((Array.isArray(output[key]) ? output[key] : []) as unknown[])
    .filter((text): text is string => typeof text === 'string');
}

async function readDebugEntries(path: string): Promise<Array<Record<string, any>>> {
  return (await readFile(path, 'utf8'))
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

function assertNoOpenPOnlyFields(event: Record<string, unknown>): void {
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'turnId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'diagnostics'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'text'), false);
}
