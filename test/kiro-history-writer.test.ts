import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { SessionHistoryTurn } from '../src/core/backend.js';
import { isAbortError } from '../src/core/abort.js';
import { OpenPError } from '../src/core/errors.js';
import {
  appendKiroSessionHistory,
  buildKiroHistoryEntries,
} from '../src/backends/kiro/history-writer.js';
import { resolveKiroSessionLogPath } from '../src/backends/kiro/session-log.js';

const GOLDEN = join(process.cwd(), 'test/fixtures/seed/redacted-kiro-golden.jsonl');
const COMPANION = join(process.cwd(), 'test/fixtures/seed/redacted-kiro-golden.json');
const FIXTURE_CWD = '/redacted/workspace';
const NOW_SEC = Math.floor(Date.UTC(2026, 6, 14, 12, 0, 0) / 1000);
const TURNS: readonly SessionHistoryTurn[] = [
  { role: 'user', text: 'U-one' },
  { role: 'assistant', text: 'A-one' },
  { role: 'user', text: 'U-two' },
  { role: 'assistant', text: 'A-two' },
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Entry = Record<string, any>;

function fixtureEntries(logText: string): Entry[] {
  return logText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function kiroText(entry: Entry): string {
  return entry.data.content[0].data;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function assertExitCode(fn: () => unknown, code: number): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OpenPError, `expected OpenPError, got ${String(error)}`);
    assert.equal(error.exitCode, code);
    return;
  }
  throw new Error(`expected throw with exit ${code}`);
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previous;
    }
  }
}

test('buildKiroHistoryEntries clones templates, freshens ids, and scopes meta to prompts', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const fixtureMessageIds = new Set(fixtureEntries(logText).map((e) => e.data?.message_id));

  const lines = buildKiroHistoryEntries(logText, TURNS, NOW_SEC);
  assert.equal(lines.length, TURNS.length);
  const appended = lines.map((l) => JSON.parse(l) as Entry);

  appended.forEach((entry, index) => {
    const turn = TURNS[index]!;
    assert.equal(entry.version, 'v1');
    assert.equal(entry.kind, turn.role === 'user' ? 'Prompt' : 'AssistantMessage');
    assert.equal(entry.data.content.length, 1);
    assert.equal(entry.data.content[0].kind, 'text');
    assert.equal(kiroText(entry), turn.text);
  });

  // Fresh, unique message ids that do not collide with the existing log.
  const messageIds = appended.map((e) => e.data.message_id);
  assert.equal(new Set(messageIds).size, messageIds.length);
  for (const id of messageIds) {
    assert.match(id, UUID_RE);
    assert.equal(fixtureMessageIds.has(id), false);
  }

  // Only Prompt records carry meta.timestamp (unix seconds, non-decreasing); AssistantMessage has none.
  const promptTimestamps: number[] = [];
  for (const entry of appended) {
    if (entry.kind === 'Prompt') {
      assert.equal(typeof entry.data.meta.timestamp, 'number');
      assert.equal(Number.isInteger(entry.data.meta.timestamp), true);
      promptTimestamps.push(entry.data.meta.timestamp);
    } else {
      assert.equal(Object.prototype.hasOwnProperty.call(entry.data, 'meta'), false);
    }
  }
  for (let i = 1; i < promptTimestamps.length; i += 1) {
    assert.ok(promptTimestamps[i]! >= promptTimestamps[i - 1]!);
  }

  // Round-trip: re-extracted texts equal the input turns.
  assert.deepEqual(appended.map(kiroText), TURNS.map((t) => t.text));
});

test('appendKiroSessionHistory appends to the jsonl and leaves the .json companion byte-identical', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    await mkdir(dirname(logPath), { recursive: true });
    const original = await readFile(GOLDEN);
    const companionOriginal = await readFile(COMPANION);
    await writeFile(logPath, original);
    await writeFile(companionPath, companionOriginal);
    const beforeSha = sha256(original);
    const companionSha = sha256(companionOriginal);

    await appendKiroSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS });

    const after = await readFile(logPath);
    assert.equal(sha256(after.subarray(0, original.length)), beforeSha, 'existing jsonl bytes must be immutable');
    assert.equal(sha256(await readFile(companionPath)), companionSha, '.json companion must be untouched');
    const originalLines = original.toString('utf8').trimEnd().split('\n');
    const afterLines = after.toString('utf8').trimEnd().split('\n');
    assert.equal(afterLines.length, originalLines.length + TURNS.length);
    const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);
    assert.deepEqual(appended.map(kiroText), TURNS.map((t) => t.text));
  });
});

test('missing Prompt or AssistantMessage template is a protocol violation', () => {
  const noPrompt = JSON.stringify({
    version: 'v1', kind: 'AssistantMessage', data: { message_id: randomUUID(), content: [{ kind: 'text', data: 'hi' }] },
  });
  assertExitCode(() => buildKiroHistoryEntries(noPrompt, TURNS, NOW_SEC), 40);

  const noAssistant = JSON.stringify({
    version: 'v1', kind: 'Prompt', data: { message_id: randomUUID(), content: [{ kind: 'text', data: 'hi' }], meta: { timestamp: NOW_SEC } },
  });
  assertExitCode(() => buildKiroHistoryEntries(noAssistant, TURNS, NOW_SEC), 40);
});

test('appendKiroSessionHistory rejects an unsafe session id as sessionLogNotFound', async () => {
  await assert.rejects(
    () => appendKiroSessionHistory({ sessionId: 'unsafe/../id', cwd: FIXTURE_CWD, turns: TURNS }),
    (error) => error instanceof OpenPError && error.exitCode === 41,
  );
});

test('appendKiroSessionHistory reports a missing log as sessionLogNotFound', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  await withHome(home, async () => {
    await assert.rejects(
      () => appendKiroSessionHistory({ sessionId: randomUUID(), cwd: FIXTURE_CWD, turns: TURNS }),
      (error) => error instanceof OpenPError && error.exitCode === 41,
    );
  });
});

test('an aborted signal rejects before the write and leaves the log untouched', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    await mkdir(dirname(logPath), { recursive: true });
    const original = await readFile(GOLDEN);
    await writeFile(logPath, original);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => appendKiroSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, signal: controller.signal }),
      isAbortError,
    );
    assert.equal(sha256(await readFile(logPath)), sha256(original), 'log must be byte-identical after an aborted append');
  });
});
