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
  appendCodexSessionHistory,
  buildCodexHistoryEntries,
} from '../src/backends/codex/history-writer.js';
import { uuidv7 } from '../src/backends/codex/uuidv7.js';

const GOLDEN = join(process.cwd(), 'test/fixtures/seed/redacted-codex-golden.jsonl');
const BOOTSTRAP = join(process.cwd(), 'test/fixtures/seed/redacted-codex-bootstrap.jsonl');
const FIXTURE_CWD = '/redacted/workspace';
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const TURNS: readonly SessionHistoryTurn[] = [
  { role: 'user', text: 'U-one' },
  { role: 'assistant', text: 'A-one' },
  { role: 'user', text: 'U-two' },
  { role: 'assistant', text: 'A-two' },
];
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MSG_ID_RE = /^msg_[0-9a-f]{32}$/;

type Entry = Record<string, any>;

function fixtureEntries(logText: string): Entry[] {
  return logText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function lastCodexUserTemplate(entries: Entry[]): Entry {
  return [...entries].reverse().find((e) =>
    e.type === 'response_item' && e.payload?.type === 'message' && e.payload?.role === 'user'
      && Array.isArray(e.payload?.content) && e.payload.content.length === 1
      && e.payload.content[0]?.type === 'input_text')!;
}

function lastCodexAssistantTemplate(entries: Entry[]): Entry {
  return [...entries].reverse().find((e) =>
    e.type === 'response_item' && e.payload?.type === 'message' && e.payload?.role === 'assistant'
      && Array.isArray(e.payload?.content) && e.payload.content.length === 1
      && e.payload.content[0]?.type === 'output_text')!;
}

function turnIdOf(entry: Entry): string {
  return entry.payload.internal_chat_message_metadata_passthrough.turn_id;
}

function uuidv7Ms(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

function codexText(entry: Entry): string {
  return entry.payload.content[0].text;
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

test('uuidv7 embeds an increasing 48-bit ms timestamp with version 7 and the 10xx variant', () => {
  const a = uuidv7(NOW);
  const b = uuidv7(NOW + 5);
  assert.match(a, UUIDV7_RE);
  assert.match(b, UUIDV7_RE);
  assert.equal(uuidv7Ms(a), NOW);
  assert.equal(uuidv7Ms(b), NOW + 5);
  assert.notEqual(a, b);
});

for (const [label, path] of [['golden', GOLDEN], ['bootstrap', BOOTSTRAP]] as const) {
  test(`buildCodexHistoryEntries clones templates, pairs turn ids, and freshens fields (${label})`, async () => {
    const logText = await readFile(path, 'utf8');
    const entries = fixtureEntries(logText);
    const userTemplate = lastCodexUserTemplate(entries);
    const assistantTemplate = lastCodexAssistantTemplate(entries);

    const lines = buildCodexHistoryEntries(logText, TURNS, NOW);
    assert.equal(lines.length, TURNS.length);
    const appended = lines.map((l) => JSON.parse(l) as Entry);

    // Roles and content reconstruction (single text block replaced in place).
    appended.forEach((entry, index) => {
      const turn = TURNS[index]!;
      assert.equal(entry.type, 'response_item');
      assert.equal(entry.payload.role, turn.role);
      assert.equal(entry.payload.type, 'message');
      assert.equal(entry.payload.content.length, 1);
      assert.equal(codexText(entry), turn.text);
    });

    // turn_id pairing: user opens a fresh UUIDv7, the following assistant inherits it.
    const ids = appended.map(turnIdOf);
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[2], ids[3]);
    assert.notEqual(ids[0], ids[2]);
    for (const id of ids) {
      assert.match(id, UUIDV7_RE);
    }
    // Turn ids are time-ordered (embedded ms is non-decreasing).
    assert.ok(uuidv7Ms(ids[0]!) <= uuidv7Ms(ids[2]!));

    // Assistant identity: fresh, unique msg_ ids; input_text content type preserved for user.
    const assistantEntries = appended.filter((e) => e.payload.role === 'assistant');
    const msgIds = assistantEntries.map((e) => e.payload.id);
    assert.equal(new Set(msgIds).size, msgIds.length);
    for (const entry of assistantEntries) {
      assert.match(entry.payload.id, MSG_ID_RE);
      assert.equal(entry.payload.content[0].type, 'output_text');
      // phase and other bookkeeping preserved from template.
      assert.equal(entry.payload.phase, assistantTemplate.payload.phase);
    }
    for (const entry of appended.filter((e) => e.payload.role === 'user')) {
      assert.equal(entry.payload.content[0].type, 'input_text');
      // User items carry no payload.id (none is synthesized).
      assert.equal(Object.prototype.hasOwnProperty.call(entry.payload, 'id'), userTemplate.payload.id !== undefined);
    }

    // Monotonic top-level timestamps, +1ms per entry from the injected clock.
    appended.forEach((entry, index) => {
      assert.equal(entry.timestamp, new Date(NOW + index).toISOString());
    });

    // Round-trip: re-extracted texts equal the input turns.
    assert.deepEqual(appended.map(codexText), TURNS.map((t) => t.text));
  });
}

test('a batch that leads with an assistant gets its own fresh turn id', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const leadTurns: readonly SessionHistoryTurn[] = [
    { role: 'assistant', text: 'A0' },
    { role: 'user', text: 'U1' },
    { role: 'assistant', text: 'A2' },
  ];
  const appended = buildCodexHistoryEntries(logText, leadTurns, NOW).map((l) => JSON.parse(l) as Entry);
  const ids = appended.map(turnIdOf);
  assert.match(ids[0]!, UUIDV7_RE); // leading assistant opened a fresh id
  assert.equal(ids[1], ids[2]); // user opened a new id, following assistant inherited it
  assert.notEqual(ids[0], ids[1]);
});

test('appendCodexSessionHistory appends to the resolved log without rewriting the prefix', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const original = await readFile(GOLDEN);
  await writeFile(logPath, original);
  const beforeSha = sha256(original);

  await appendCodexSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, homeDir });

  const after = await readFile(logPath);
  assert.equal(sha256(after.subarray(0, original.length)), beforeSha, 'existing bytes (instructions head included) must be immutable');
  const originalLines = original.toString('utf8').trimEnd().split('\n');
  const afterLines = after.toString('utf8').trimEnd().split('\n');
  assert.equal(afterLines.length, originalLines.length + TURNS.length);
  const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);
  assert.deepEqual(appended.map(codexText), TURNS.map((t) => t.text));
});

test('missing user or assistant template is a protocol violation', () => {
  const noUser = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  });
  assertExitCode(() => buildCodexHistoryEntries(noUser, TURNS, NOW), 40);

  const noAssistant = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  });
  assertExitCode(() => buildCodexHistoryEntries(noAssistant, TURNS, NOW), 40);
});

test('unparseable lines are skipped, not rewritten or fatal', async () => {
  const logText = `not json\n${await readFile(GOLDEN, 'utf8')}\n{unterminated`;
  const lines = buildCodexHistoryEntries(logText, TURNS, NOW);
  assert.equal(lines.length, TURNS.length);
  assert.deepEqual(lines.map((l) => codexText(JSON.parse(l))), TURNS.map((t) => t.text));
});

test('appendCodexSessionHistory reports a missing log as sessionLogNotFound', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  await assert.rejects(
    () => appendCodexSessionHistory({ sessionId: randomUUID(), cwd: FIXTURE_CWD, turns: TURNS, homeDir }),
    (error) => error instanceof OpenPError && error.exitCode === 41,
  );
});

test('an aborted signal rejects before the write and leaves the log untouched', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const original = await readFile(GOLDEN);
  await writeFile(logPath, original);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => appendCodexSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, homeDir, signal: controller.signal }),
    isAbortError,
  );
  assert.equal(sha256(await readFile(logPath)), sha256(original), 'log must be byte-identical after an aborted append');
});
