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
  appendClaudeCodeSessionHistory,
  buildClaudeCodeHistoryEntries,
} from '../src/backends/claude/history-writer.js';
import { resolveClaudeCodeSessionLogPath } from '../src/backends/claude/session-log.js';

const GOLDEN = join(process.cwd(), 'test/fixtures/seed/redacted-claude-golden.jsonl');
const BOOTSTRAP = join(process.cwd(), 'test/fixtures/seed/redacted-claude-bootstrap.jsonl');
const FIXTURE_CWD = '/redacted/workspace';
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const TURNS: readonly SeedWriteTurn[] = [
  { logicalId: 'turn-1', userText: 'U-one', assistantText: 'A-one', contentDigest: 'digest-1', sourceNativeIds: null },
  { logicalId: 'turn-2', userText: 'U-two', assistantText: 'A-two', contentDigest: 'digest-2', sourceNativeIds: null },
];
const EXPECTED_TEXT_ENTRIES = TURNS.flatMap((turn) => [
  { role: 'user', text: turn.userText },
  { role: 'assistant', text: turn.assistantText },
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Entry = Record<string, any>;

function fixtureEntries(logText: string): Entry[] {
  return logText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function lastUserTemplate(entries: Entry[]): Entry {
  return [...entries].reverse().find((e) =>
    e.type === 'user' && e.isSidechain !== true && typeof e.message?.content === 'string')!;
}

function lastAssistantTemplate(entries: Entry[]): Entry {
  return [...entries].reverse().find((e) =>
    e.type === 'assistant' && Array.isArray(e.message?.content)
      && e.message.content.some((b: any) => b?.type === 'text'))!;
}

function lastUuid(entries: Entry[]): string {
  return [...entries].reverse().find((e) => typeof e.uuid === 'string' && e.uuid.length > 0)!.uuid;
}

function extractedText(entry: Entry): string {
  return entry.type === 'user' ? entry.message.content : entry.message.content[0].text;
}

function textEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.type === 'user' || entry.type === 'assistant');
}

function completionEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.type === 'system' && entry.subtype === 'turn_duration');
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

for (const [label, path] of [['golden', GOLDEN], ['bootstrap', BOOTSTRAP]] as const) {
  test(`buildClaudeCodeHistoryEntries clones templates, chains, and freshens fields (${label})`, async () => {
    const logText = await readFile(path, 'utf8');
    const entries = fixtureEntries(logText);
    const userTemplate = lastUserTemplate(entries);
    const assistantTemplate = lastAssistantTemplate(entries);
    const chainStart = lastUuid(entries);
    const fixtureUuids = new Set(entries.filter((e) => typeof e.uuid === 'string').map((e) => e.uuid));

    const built = buildClaudeCodeHistoryEntries(logText, TURNS, NOW);
    const lines = built.lines;
    assert.equal(lines.length, TURNS.length * 3);
    assert.equal(built.written.length, TURNS.length);
    const appended = lines.map((l) => JSON.parse(l) as Entry);

    // Native sequence and content reconstruction: user, assistant, completion boundary per turn.
    TURNS.forEach((turn, turnIndex) => {
      const base = turnIndex * 3;
      const userEntry = appended[base]!;
      const assistantEntry = appended[base + 1]!;
      const completionEntry = appended[base + 2]!;
      assert.equal(userEntry.type, 'user');
      assert.equal(userEntry.message.content, turn.userText);
      assert.equal(assistantEntry.type, 'assistant');
      assert.deepEqual(assistantEntry.message.content, [{ type: 'text', text: turn.assistantText }]);
      assert.equal(completionEntry.type, 'system');
      assert.equal(completionEntry.subtype, 'turn_duration');
      assert.equal(completionEntry.durationMs, 0);
      assert.equal(built.written[turnIndex]!.nativeIds.userId, userEntry.uuid);
      assert.deepEqual(built.written[turnIndex]!.nativeIds.assistantIds, [assistantEntry.message.id]);
      assert.equal(built.written[turnIndex]!.nativeIds.completionId, completionEntry.uuid);
    });

    // parentUuid chain: first entry off the fixture's last uuid, then each off the previous.
    assert.equal(appended[0]!.parentUuid, chainStart);
    for (let i = 1; i < appended.length; i += 1) {
      assert.equal(appended[i]!.parentUuid, appended[i - 1]!.uuid);
    }

    // Fresh, unique uuids that do not collide with the existing log.
    const uuids = appended.map((e) => e.uuid);
    assert.equal(new Set(uuids).size, uuids.length);
    for (const uuid of uuids) {
      assert.match(uuid, UUID_RE);
      assert.equal(fixtureUuids.has(uuid), false);
    }

    // Per-role fresh identity fields.
    for (const entry of textEntries(appended)) {
      if (entry.type === 'user') {
        assert.match(entry.promptId, UUID_RE);
      } else {
        assert.match(entry.message.id, /^msg_[0-9a-f]{32}$/);
        assert.match(entry.requestId, /^req_[0-9a-f]{24}$/);
      }
    }

    // Monotonic timestamps, +1ms per entry from the supplied clock.
    appended.forEach((entry, index) => {
      assert.equal(entry.timestamp, new Date(NOW + index).toISOString());
    });

    // Bookkeeping fields keep their template values (drift resistance via runtime golden).
    for (const entry of appended.filter((e) => e.type === 'user')) {
      assert.equal(entry.sessionId, userTemplate.sessionId);
      assert.equal(entry.cwd, userTemplate.cwd);
      assert.equal(entry.version, userTemplate.version);
    }
    for (const entry of appended.filter((e) => e.type === 'assistant')) {
      assert.equal(entry.message.model, assistantTemplate.message.model);
      assert.deepEqual(entry.message.usage, assistantTemplate.message.usage);
      assert.equal(entry.cwd, assistantTemplate.cwd);
    }
    assert.equal(completionEntries(appended).length, TURNS.length);

    // Round-trip: re-extracted texts equal the input turns.
    assert.deepEqual(textEntries(appended).map(extractedText), EXPECTED_TEXT_ENTRIES.map((t) => t.text));
    assert.deepEqual(built.written.map((turn) => turn.logicalId), TURNS.map((turn) => turn.logicalId));
  });
}

test('appendClaudeCodeSessionHistory appends to the resolved log without rewriting the prefix', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-cfg-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const original = await readFile(GOLDEN);
  await writeFile(logPath, original);
  const beforeSha = createHash('sha256').update(original).digest('hex');

  await appendClaudeCodeSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, configDir });

  const after = await readFile(logPath);
  assert.equal(
    createHash('sha256').update(after.subarray(0, original.length)).digest('hex'),
    beforeSha,
    'existing bytes must be immutable',
  );
  const originalLines = original.toString('utf8').trimEnd().split('\n');
  const afterLines = after.toString('utf8').trimEnd().split('\n');
  assert.equal(afterLines.length, originalLines.length + TURNS.length * 3);
  const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);
  assert.equal(appended[0]!.parentUuid, lastUuid(fixtureEntries(original.toString('utf8'))));
  assert.deepEqual(textEntries(appended).map(extractedText), EXPECTED_TEXT_ENTRIES.map((t) => t.text));
  assert.equal(completionEntries(appended).length, TURNS.length);
});

test('missing user or assistant template is a protocol violation', () => {
  const noUser = JSON.stringify({
    type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  });
  assertExitCode(() => buildClaudeCodeHistoryEntries(noUser, TURNS, NOW), 40);

  const noAssistant = JSON.stringify({
    type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'hi' },
  });
  assertExitCode(() => buildClaudeCodeHistoryEntries(noAssistant, TURNS, NOW), 40);
});

test('a log with templates but no uuid-bearing entry is a protocol violation', () => {
  const logText = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }),
  ].join('\n');
  assertExitCode(() => buildClaudeCodeHistoryEntries(logText, TURNS, NOW), 40);
});

test('sidechain and meta entries are never selected as Claude seed templates', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const poisoned = [
    logText.trimEnd(),
    JSON.stringify({
      type: 'user', isMeta: true, uuid: randomUUID(), message: { role: 'user', content: 'META-USER' },
    }),
    JSON.stringify({
      type: 'assistant', isSidechain: true, uuid: randomUUID(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN-ASSISTANT' }] },
    }),
    JSON.stringify({
      type: 'system', subtype: 'turn_duration', isMeta: true, uuid: randomUUID(), durationMs: 999,
    }),
  ].join('\n');

  const built = buildClaudeCodeHistoryEntries(poisoned, TURNS.slice(0, 1), NOW);
  const appended = built.lines.map((line) => JSON.parse(line) as Entry);
  assert.equal(appended[0]!.message.content, 'U-one');
  assert.equal(appended[1]!.message.content[0].text, 'A-one');
  assert.equal(appended[2]!.durationMs, 0);
  assert.notEqual(appended[0]!.isMeta, true);
  assert.notEqual(appended[1]!.isSidechain, true);
  assert.notEqual(appended[2]!.isMeta, true);
});

test('prompt-id-linked local command transcripts are never selected as Claude user templates', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const parent = lastUuid(fixtureEntries(logText));
  const poisoned = [
    logText.trimEnd(),
    JSON.stringify({
      type: 'user', isMeta: true, uuid: 'writer-local-caveat', parentUuid: parent,
      promptId: 'writer-local-group',
      message: { role: 'user', content: '<local-command-caveat>local command</local-command-caveat>' },
    }),
    JSON.stringify({
      type: 'user', uuid: 'writer-local-name', parentUuid: 'writer-local-caveat',
      promptId: 'writer-local-group', localCommandTemplatePoison: true,
      message: { role: 'user', content: '<command-name>/exit</command-name>' },
    }),
    JSON.stringify({
      type: 'user', uuid: 'writer-local-output', parentUuid: 'writer-local-name',
      promptId: 'writer-local-group', localCommandTemplatePoison: true,
      message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' },
    }),
  ].join('\n');

  const built = buildClaudeCodeHistoryEntries(poisoned, TURNS.slice(0, 1), NOW);
  const appendedUser = JSON.parse(built.lines[0]!) as Entry;
  assert.equal(appendedUser.message.content, 'U-one');
  assert.equal(appendedUser.localCommandTemplatePoison, undefined);
});

test('unparseable lines are skipped, not rewritten or fatal', async () => {
  const logText = `not json\n${await readFile(GOLDEN, 'utf8')}\n{unterminated`;
  const built = buildClaudeCodeHistoryEntries(logText, TURNS, NOW);
  assert.equal(built.lines.length, TURNS.length * 3);
  const appended = built.lines.map((l) => JSON.parse(l) as Entry);
  assert.deepEqual(textEntries(appended).map(extractedText), EXPECTED_TEXT_ENTRIES.map((t) => t.text));
  assert.equal(completionEntries(appended).length, TURNS.length);
});

test('appendClaudeCodeSessionHistory reports a missing log as sessionLogNotFound', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-cfg-'));
  await assert.rejects(
    () => appendClaudeCodeSessionHistory({ sessionId: randomUUID(), cwd: FIXTURE_CWD, turns: TURNS, configDir }),
    (error) => error instanceof OpenPError && error.exitCode === 41,
  );
});

test('an aborted signal rejects before the write and leaves the log untouched', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-cfg-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const original = await readFile(GOLDEN);
  await writeFile(logPath, original);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => appendClaudeCodeSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, configDir, signal: controller.signal }),
    isAbortError,
  );
  assert.equal(
    createHash('sha256').update(await readFile(logPath)).digest('hex'),
    createHash('sha256').update(original).digest('hex'),
    'log must be byte-identical after an aborted append',
  );
});
