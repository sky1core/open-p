import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readClaudeCodeSelectionPromptScreen } from '../../src/backends/claude/interactive.js';
import {
  nextSelectionPromptStallObservations,
  SELECTION_PROMPT_STALL_CONFIRMATIONS,
  sessionLogHasStoodStill,
  waitForClaudeCodeTurnResult,
} from '../../src/backends/claude/session-log.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(20);
  }
  assert.equal(predicate(), true);
}

// These live in their own file on purpose: they assert that a turn is NOT failed while its session
// log keeps advancing, which needs the poller to read each write promptly. Sharing a process with
// the rest of the session-log suite lets that suite's own polling waits delay the read past the
// stall grace, which fails the turn for a reason the test is not about.

// A Claude backend can stop mid-turn on a selection prompt it wants a person to answer (a usage
// limit reached during the turn reads this way). The process stays alive, so liveness reports the
// turn as still running and the wait would otherwise run to the caller's timeout -- unbounded when
// the caller set none. These cover failing on that evidence without failing a turn that is working.
test('a turn stalled on a backend selection prompt fails with the screen instead of waiting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-selection-prompt-stall-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({ type: 'user', message: { content: 'hello' } }));
  let screenReads = 0;

  await assert.rejects(
    waitForClaudeCodeTurnResult({
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: 'turn-1',
      timeoutMs: 30_000,
      initialOffset: 0,
      knownLogPath: logPath,
      isBackendAlive: async () => true,
      selectionPromptStallGraceMs: 0.0001,
      readBackendSelectionPromptScreen: async () => {
        screenReads += 1;
        return '\nLast Claude Code screen:\n❯ 1. Stop and wait for limit to reset';
      },
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendStartFailed &&
      error.message.includes('turn-1') &&
      error.message.includes('Stop and wait for limit to reset'),
  );
  // Two consecutive readings are required, so one bad capture cannot end a live turn.
  assert.equal(screenReads, 2);
});

test('a turn whose log still advances keeps waiting while a selection prompt is visible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-selection-prompt-draft-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({ type: 'user', message: { content: 'hello' } }));

  // The composer holds a draft beginning with a number, which is the same text as a selection
  // prompt on the input line. The turn is working, so the log keeps advancing and it must finish.
  const pending = waitForClaudeCodeTurnResult({
    sessionId: '22222222-2222-4222-8222-222222222222',
    turnId: 'turn-1',
    timeoutMs: 30_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    selectionPromptStallGraceMs: 200,
    readBackendSelectionPromptScreen: async () => '\nLast Claude Code screen:\n❯ 1. a numbered draft',
  });

  // Structurally longer than the grace (6 * 60ms > 200ms), so a missing progress reset would fail
  // the turn even though every individual gap stays under it.
  for (let append = 0; append < 6; append += 1) {
    await sleep(60);
    await appendFile(logPath, line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `working ${append}` }] },
    }));
  }
  await appendFile(logPath, [
    line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'finished anyway' }], stop_reason: 'end_turn' },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  // The streamed progress accumulates ahead of the final text; what this asserts is that the turn
  // reached its own completion rather than being failed as stalled.
  assert.equal((await pending).text.endsWith('finished anyway'), true);
});

test('a stalled turn whose backend shows no selection prompt keeps waiting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-selection-prompt-absent-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({ type: 'user', message: { content: 'hello' } }));
  let screenReads = 0;

  // A long tool call leaves the log this quiet, and that alone must never end a turn.
  const pending = waitForClaudeCodeTurnResult({
    sessionId: '33333333-3333-4333-8333-333333333333',
    turnId: 'turn-1',
    timeoutMs: 30_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    selectionPromptStallGraceMs: 0.0001,
    readBackendSelectionPromptScreen: async () => {
      screenReads += 1;
      return null;
    },
  });

  await waitUntil(() => screenReads >= 5);
  await appendFile(logPath, [
    line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'tool call returned' }], stop_reason: 'end_turn' },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  assert.equal((await pending).text, 'tool call returned');
});

test('a caller that reads no backend screen keeps the unbounded wait it had', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-selection-prompt-unwired-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({ type: 'user', message: { content: 'hello' } }));

  const pending = waitForClaudeCodeTurnResult({
    sessionId: '44444444-4444-4444-8444-444444444444',
    turnId: 'turn-1',
    timeoutMs: 30_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    selectionPromptStallGraceMs: 0.0001,
  });

  await sleep(150);
  await appendFile(logPath, [
    line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'no screen reader wired' }], stop_reason: 'end_turn' },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  assert.equal((await pending).text, 'no screen reader wired');
});

test('a selection prompt that comes and goes between readings does not fail the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-selection-prompt-intermittent-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({ type: 'user', message: { content: 'hello' } }));
  let screenReads = 0;

  // The readings alternate, so the prompt is never seen twice running. Only a reading that clears
  // the count can keep this from adding up to a failure across unrelated sightings.
  const pending = waitForClaudeCodeTurnResult({
    sessionId: '55555555-5555-4555-8555-555555555555',
    turnId: 'turn-1',
    timeoutMs: 30_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    selectionPromptStallGraceMs: 0.0001,
    readBackendSelectionPromptScreen: async () => {
      screenReads += 1;
      return screenReads % 2 === 1 ? '\nLast Claude Code screen:\n❯ 1. transient' : null;
    },
  });

  await waitUntil(() => screenReads >= 8);
  await appendFile(logPath, [
    line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'never stalled' }], stop_reason: 'end_turn' },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  assert.equal((await pending).text, 'never stalled');
});

test('stall readings only add up while the same stall lasts', () => {
  // Timing decides only whether the log stood still; what a reading then means is this rule, so it
  // is settled here rather than through a wait whose scheduling can starve a write.
  assert.equal(sessionLogHasStoodStill(299_999, 300_000), false);
  assert.equal(sessionLogHasStoodStill(300_000, 300_000), true);

  // A reading during a stall adds up.
  assert.equal(nextSelectionPromptStallObservations(0, true, true), 1);
  assert.equal(nextSelectionPromptStallObservations(1, true, true), 2);
  // The log advancing ends the stall, so an earlier reading cannot combine with a later one.
  assert.equal(nextSelectionPromptStallObservations(1, false, true), 0);
  // A reading that finds no prompt ends it too.
  assert.equal(nextSelectionPromptStallObservations(1, true, false), 0);
  assert.equal(nextSelectionPromptStallObservations(1, false, false), 0);

  // The threshold is what makes a single reading insufficient.
  assert.equal(SELECTION_PROMPT_STALL_CONFIRMATIONS, 2);
});

test('the backend selection-prompt reader returns a screen only for a selection cursor line', async () => {
  const screen = 'What do you want to do?\n❯ 1. Stop and wait for limit to reset\n2. Add funds';
  const reader = (cursorLine: string) => readClaudeCodeSelectionPromptScreen({
    captureCursorLine: async () => cursorLine,
    captureText: async () => screen,
  });

  assert.equal((await reader('❯ 1. Stop and wait for limit to reset'))?.includes('Add funds'), true);
  assert.equal(await reader('❯ '), null);
  assert.equal(await reader('❯ a normal typed draft'), null);
  // The turn is what matters here, not the shape of the reader's own failure: an unreadable screen
  // must read as "no selection prompt" so a capture fault cannot end a live turn.
  assert.equal(
    await readClaudeCodeSelectionPromptScreen({
      captureCursorLine: async () => { throw new Error('pane is gone'); },
      captureText: async () => screen,
    }),
    null,
  );
});
