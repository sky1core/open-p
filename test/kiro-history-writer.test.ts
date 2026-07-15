import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { SeedWriteTurn } from '../src/core/backend.js';
import { isAbortError } from '../src/core/abort.js';
import { OpenPError } from '../src/core/errors.js';
import {
  appendKiroSessionHistory,
  buildKiroCompanionWithAppendedTurns,
  buildKiroHistoryEntries,
  commitKiroHistoryAppend,
} from '../src/backends/kiro/history-writer.js';
import { resolveKiroSessionLogPath } from '../src/backends/kiro/session-log.js';

const GOLDEN = join(process.cwd(), 'test/fixtures/seed/redacted-kiro-golden.jsonl');
const COMPANION = join(process.cwd(), 'test/fixtures/seed/redacted-kiro-golden.json');
const FIXTURE_CWD = '/redacted/workspace';
const NOW_SEC = Math.floor(Date.UTC(2026, 6, 14, 12, 0, 0) / 1000);
const TURNS: readonly SeedWriteTurn[] = [
  { logicalId: 'turn-1', userText: 'U-one', assistantText: 'A-one', contentDigest: 'digest-1', sourceNativeIds: null },
  { logicalId: 'turn-2', userText: 'U-two', assistantText: 'A-two', contentDigest: 'digest-2', sourceNativeIds: null },
];
const EXPECTED_ENTRIES = TURNS.flatMap((turn) => [
  { role: 'user', text: turn.userText },
  { role: 'assistant', text: turn.assistantText },
]);
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

  const built = buildKiroHistoryEntries(logText, TURNS, NOW_SEC);
  const lines = built.lines;
  assert.equal(lines.length, EXPECTED_ENTRIES.length);
  assert.equal(built.written.length, TURNS.length);
  const appended = lines.map((l) => JSON.parse(l) as Entry);

  appended.forEach((entry, index) => {
    const turn = EXPECTED_ENTRIES[index]!;
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
  assert.deepEqual(appended.map(kiroText), EXPECTED_ENTRIES.map((t) => t.text));
  assert.deepEqual(built.written.map((turn) => turn.logicalId), TURNS.map((turn) => turn.logicalId));
});

test('appendKiroSessionHistory appends to the jsonl and updates the .json companion completions', async () => {
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
    const beforeCompanion = JSON.parse(companionOriginal.toString('utf8'));
    const beforeMetadataCount = beforeCompanion.session_state.conversation_metadata.user_turn_metadatas.length;

    const result = await appendKiroSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS });

    const after = await readFile(logPath);
    assert.equal(sha256(after.subarray(0, original.length)), beforeSha, 'existing jsonl bytes must be immutable');
    const originalLines = original.toString('utf8').trimEnd().split('\n');
    const afterLines = after.toString('utf8').trimEnd().split('\n');
    assert.equal(afterLines.length, originalLines.length + EXPECTED_ENTRIES.length);
    const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);
    assert.deepEqual(appended.map(kiroText), EXPECTED_ENTRIES.map((t) => t.text));
    assert.equal(result.turns.length, TURNS.length);
    const afterCompanion = JSON.parse(await readFile(companionPath, 'utf8'));
    const metadatas = afterCompanion.session_state.conversation_metadata.user_turn_metadatas;
    assert.equal(metadatas.length, beforeMetadataCount + TURNS.length);
    const appendedMetadata = metadatas.slice(beforeMetadataCount);
    assert.deepEqual(appendedMetadata.map((m: any) => m.message_ids), result.turns.map((turn) => [
      turn.nativeIds.userId,
      ...turn.nativeIds.assistantIds,
    ]));
    assert.deepEqual(appendedMetadata.map((m: any) => m.result.Ok.content[0].data), TURNS.map((turn) => turn.assistantText));
  });
});

test('companion publish failure rolls the JSONL append back to its exact prior bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-kiro-transaction-'));
  const logPath = join(dir, 'session.jsonl');
  const companionPath = join(dir, 'companion.json');
  const original = Buffer.from('{"existing":true}\n');
  await writeFile(logPath, original);
  await mkdir(companionPath);

  await assert.rejects(() => commitKiroHistoryAppend({
    logPath,
    companionPath,
    lines: ['{"new":true}'],
    companion: '{"updated":true}\n',
  }));
  assert.deepEqual(await readFile(logPath), original);
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

test('malformed companion JSON is a protocol violation', () => {
  assertExitCode(() => buildKiroCompanionWithAppendedTurns('{not-json', TURNS, []), 40);
});

test('companion version drift is a protocol violation', async () => {
  const companion = JSON.parse(await readFile(COMPANION, 'utf8'));
  companion.session_state.version = 'v2';
  assertExitCode(() => buildKiroCompanionWithAppendedTurns(JSON.stringify(companion), TURNS, []), 40);
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
