import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { SeedWriteTurn } from '../../src/core/backend.js';
import { isAbortError } from '../../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';
import {
  appendCodexSessionHistory,
  buildCodexHistoryEntries,
} from '../../src/backends/codex/history-writer.js';
import { codexNativeStateDigest, extractCodexNativeTurns, readCodexNativeSession } from '../../src/backends/codex/native-reader.js';
import { uuidv7 } from '../../src/backends/codex/uuidv7.js';
import { installFileDriftOnNextSync } from '../helpers/native-file-sync-fault.js';

const GOLDEN = join(import.meta.dirname, 'fixture-codex-golden.jsonl');
const BOOTSTRAP = join(import.meta.dirname, 'fixture-codex-bootstrap.jsonl');
const FIXTURE_CWD = '/fixture/workspace';
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const persistPreparedAppend = async (): Promise<void> => undefined;
const TURNS: readonly SeedWriteTurn[] = [
  { logicalId: 'turn-1', userText: 'U-one', assistantText: 'A-one', contentDigest: 'digest-1', sourceNativeIds: null },
  { logicalId: 'turn-2', userText: 'U-two', assistantText: 'A-two', contentDigest: 'digest-2', sourceNativeIds: null },
];
const EXPECTED_TEXT_ENTRIES = TURNS.flatMap((turn) => [
  { role: 'user', text: turn.userText },
  { role: 'assistant', text: turn.assistantText },
]);
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MSG_ID_RE = /^msg_[0-9a-f]{32}$/;

type Entry = Record<string, any>;

function fixtureEntries(logText: string): Entry[] {
  return logText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function logForSession(logText: string, sessionId: string): string {
  return fixtureEntries(logText).map((entry) => {
    const copy = structuredClone(entry);
    if (copy.type === 'session_meta' && copy.payload && typeof copy.payload === 'object') {
      copy.payload.id = sessionId;
      if (Object.prototype.hasOwnProperty.call(copy.payload, 'session_id')) {
        copy.payload.session_id = sessionId;
      }
    }
    return JSON.stringify(copy);
  }).join('\n') + '\n';
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

function eventTurnIdOf(entry: Entry): string {
  return entry.payload.turn_id;
}

function uuidv7Ms(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

function codexText(entry: Entry): string {
  return entry.payload.content[0].text;
}

function responseItems(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.type === 'response_item');
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

    const built = buildCodexHistoryEntries(logText, TURNS, NOW);
    const lines = built.lines;
    assert.equal(lines.length, TURNS.length * 5);
    assert.equal(built.written.length, TURNS.length);
    const appended = lines.map((l) => JSON.parse(l) as Entry);

    // Native sequence and content reconstruction per turn:
    // task_started, user, user_message mirror, assistant, task_complete.
    TURNS.forEach((turn, turnIndex) => {
      const base = turnIndex * 5;
      const startedEntry = appended[base]!;
      const userEntry = appended[base + 1]!;
      const mirrorEntry = appended[base + 2]!;
      const assistantEntry = appended[base + 3]!;
      const completedEntry = appended[base + 4]!;
      assert.equal(startedEntry.type, 'event_msg');
      assert.equal(startedEntry.payload.type, 'task_started');
      assert.equal(userEntry.type, 'response_item');
      assert.equal(userEntry.payload.role, 'user');
      assert.equal(userEntry.payload.type, 'message');
      assert.equal(userEntry.payload.content.length, 1);
      assert.equal(codexText(userEntry), turn.userText);
      // The caller-evidence mirror directly follows the user record and carries the fixed shape:
      // no payload id and no turn_id, so it can never masquerade as a portable native id.
      assert.equal(mirrorEntry.type, 'event_msg');
      assert.deepEqual(mirrorEntry.payload, { type: 'user_message', message: turn.userText });
      assert.equal(assistantEntry.type, 'response_item');
      assert.equal(assistantEntry.payload.role, 'assistant');
      assert.equal(assistantEntry.payload.type, 'message');
      assert.equal(assistantEntry.payload.content.length, 1);
      assert.equal(codexText(assistantEntry), turn.assistantText);
      assert.equal(completedEntry.type, 'event_msg');
      assert.equal(completedEntry.payload.type, 'task_complete');
      assert.equal(completedEntry.payload.last_agent_message, turn.assistantText);
      assert.equal(completedEntry.payload.duration_ms, 0);
      assert.equal(completedEntry.payload.time_to_first_token_ms, 0);

      const turnId = turnIdOf(userEntry);
      assert.equal(eventTurnIdOf(startedEntry), turnId);
      assert.equal(turnIdOf(assistantEntry), turnId);
      assert.equal(eventTurnIdOf(completedEntry), turnId);
      assert.equal(built.written[turnIndex]!.nativeIds.userId, `user:${turnId}`);
      assert.deepEqual(built.written[turnIndex]!.nativeIds.assistantIds, [assistantEntry.payload.id]);
      assert.equal(built.written[turnIndex]!.nativeIds.completionId, turnId);
    });

    // turn_id pairing: each native pair has one fresh UUIDv7 shared by task/user/assistant/completion.
    const ids = responseItems(appended).filter((entry) => entry.payload.role === 'user').map(turnIdOf);
    assert.notEqual(ids[0], ids[1]);
    for (const id of ids) {
      assert.match(id, UUIDV7_RE);
    }
    // Turn ids are time-ordered (embedded ms is non-decreasing).
    assert.ok(uuidv7Ms(ids[0]!) <= uuidv7Ms(ids[1]!));

    // Assistant identity: fresh, unique msg_ ids; input_text content type preserved for user.
    const assistantEntries = responseItems(appended).filter((e) => e.payload.role === 'assistant');
    const msgIds = assistantEntries.map((e) => e.payload.id);
    assert.equal(new Set(msgIds).size, msgIds.length);
    for (const entry of assistantEntries) {
      assert.match(entry.payload.id, MSG_ID_RE);
      assert.equal(entry.payload.content[0].type, 'output_text');
      // phase and other bookkeeping preserved from template.
      assert.equal(entry.payload.phase, assistantTemplate.payload.phase);
    }
    for (const entry of responseItems(appended).filter((e) => e.payload.role === 'user')) {
      assert.equal(entry.payload.content[0].type, 'input_text');
      // User items carry no payload.id; inherited template ids would collide across seeded turns.
      assert.equal(Object.prototype.hasOwnProperty.call(entry.payload, 'id'), false);
    }

    // Timestamps follow Codex turn boundaries: start/user/mirror share the start, assistant/complete
    // share completion.
    TURNS.forEach((_turn, turnIndex) => {
      const base = turnIndex * 5;
      assert.equal(appended[base]!.timestamp, new Date(NOW + turnIndex * 2).toISOString());
      assert.equal(appended[base + 1]!.timestamp, new Date(NOW + turnIndex * 2).toISOString());
      assert.equal(appended[base + 2]!.timestamp, new Date(NOW + turnIndex * 2).toISOString());
      assert.equal(appended[base + 3]!.timestamp, new Date(NOW + turnIndex * 2 + 1).toISOString());
      assert.equal(appended[base + 4]!.timestamp, new Date(NOW + turnIndex * 2 + 1).toISOString());
    });

    // Round-trip: re-extracted texts equal the input turns.
    assert.deepEqual(responseItems(appended).map(codexText), EXPECTED_TEXT_ENTRIES.map((t) => t.text));
    assert.deepEqual(built.written.map((turn) => turn.logicalId), TURNS.map((turn) => turn.logicalId));

    // Reader round-trip: the seeded turns come back as portable turns with the caller's exact
    // texts, and the mirror never surfaces as an extra user or assistant text.
    const fixtureTurns = extractCodexNativeTurns(logText);
    const reread = extractCodexNativeTurns(`${logText.trimEnd()}\n${lines.join('\n')}\n`);
    assert.equal(reread.length, fixtureTurns.length + TURNS.length);
    const rereadSuffix = reread.slice(fixtureTurns.length);
    assert.deepEqual(rereadSuffix.map((turn) => turn.userText), TURNS.map((turn) => turn.userText));
    assert.deepEqual(rereadSuffix.map((turn) => turn.assistantText), TURNS.map((turn) => turn.assistantText));
    assert.deepEqual(rereadSuffix.map((turn) => turn.nativeIds), built.written.map((turn) => turn.nativeIds));
  });
}

test('each pair gets a fresh turn id shared by user and assistant', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const appended = buildCodexHistoryEntries(logText, TURNS, NOW).lines.map((l) => JSON.parse(l) as Entry);
  for (let turnIndex = 0; turnIndex < TURNS.length; turnIndex += 1) {
    const base = turnIndex * 5;
    const turnId = eventTurnIdOf(appended[base]!);
    assert.equal(turnIdOf(appended[base + 1]!), turnId);
    // The user_message mirror at base + 2 carries no turn_id; the fresh id binds the pair around it.
    assert.equal(turnIdOf(appended[base + 3]!), turnId);
    assert.equal(eventTurnIdOf(appended[base + 4]!), turnId);
    assert.match(turnId, UUIDV7_RE);
  }
  assert.notEqual(eventTurnIdOf(appended[0]!), eventTurnIdOf(appended[5]!));
});

test('user template payload ids are removed instead of being cloned into seeded turns', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const template = structuredClone(lastCodexUserTemplate(fixtureEntries(logText)));
  template.payload.id = 'template-user-id';
  const built = buildCodexHistoryEntries(`${logText.trimEnd()}\n${JSON.stringify(template)}\n`, TURNS, NOW);
  const users = responseItems(built.lines.map((line) => JSON.parse(line) as Entry))
    .filter((entry) => entry.payload.role === 'user');
  assert.equal(users.length, TURNS.length);
  assert.ok(users.every((entry) => !Object.prototype.hasOwnProperty.call(entry.payload, 'id')));
  assert.deepEqual(
    built.written.map((turn, index) => turn.nativeIds.userId === `user:${turnIdOf(users[index]!)}`),
    TURNS.map(() => true),
  );
});

test('appendCodexSessionHistory appends to the resolved log without rewriting the prefix', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const original = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId));
  await writeFile(logPath, original);
  const beforeSha = sha256(original);
  let preparationCalls = 0;
  let preparedCandidateDigest: string | null = null;

  await appendCodexSessionHistory({
    sessionId,
    cwd: FIXTURE_CWD,
    turns: TURNS,
    homeDir,
    persistPreparedAppend: async (prepared) => {
      preparationCalls += 1;
      preparedCandidateDigest = prepared.candidateNativeStateDigest;
      assert.equal(prepared.turns.length, TURNS.length);
      assert.deepEqual(await readFile(logPath), original, 'durability barrier must precede native mutation');
    },
  });

  const after = await readFile(logPath);
  assert.equal(preparationCalls, 1);
  assert.equal(codexNativeStateDigest(after), preparedCandidateDigest);
  assert.equal(sha256(after.subarray(0, original.length)), beforeSha, 'existing bytes (instructions head included) must be immutable');
  const originalLines = original.toString('utf8').trimEnd().split('\n');
  const afterLines = after.toString('utf8').trimEnd().split('\n');
  assert.equal(afterLines.length, originalLines.length + TURNS.length * 5);
  const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);
  assert.deepEqual(responseItems(appended).map(codexText), EXPECTED_TEXT_ENTRIES.map((t) => t.text));
  // Every appended user record is immediately mirrored as caller evidence.
  appended.forEach((entry, index) => {
    if (entry.type !== 'response_item' || entry.payload.role !== 'user') return;
    const next = appended[index + 1]!;
    assert.equal(next.type, 'event_msg');
    assert.deepEqual(next.payload, { type: 'user_message', message: codexText(entry) });
  });
});

test('Codex production reader confirms a stable file-backed settlement snapshot', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-settlement-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const bytes = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId));
  await writeFile(logPath, bytes);

  const read = await readCodexNativeSession({
    backend: 'codex',
    sessionId,
    homeDir,
    mode: 'settlement',
  });

  assert.equal(read.nativeStateDigest, codexNativeStateDigest(bytes));
  assert.equal(read.turns.length > 0, true);
});

test('Codex production reader rejects first-read drift only in settlement mode', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-settlement-drift-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const bytes = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId));
  await writeFile(logPath, bytes);
  const fault = await installFileDriftOnNextSync(logPath, Buffer.concat([bytes, Buffer.from('\n')]));
  try {
    await assert.doesNotReject(() => readCodexNativeSession({
      backend: 'codex', sessionId, homeDir, mode: 'logical',
    }));
    assert.equal(fault.wasTriggered(), false);
    await assert.rejects(
      () => readCodexNativeSession({ backend: 'codex', sessionId, homeDir, mode: 'settlement' }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation &&
        error.message.includes('changed during durability confirmation'),
    );
    assert.equal(fault.wasTriggered(), true);
  } finally {
    fault.restore();
  }
});

test('appendCodexSessionHistory rejects a foreign session_meta before mutation', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const foreign = await readFile(GOLDEN);
  await writeFile(logPath, foreign);

  await assert.rejects(
    () => appendCodexSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, homeDir }),
    (error) => error instanceof OpenPError && error.exitCode === 40,
  );
  assert.deepEqual(await readFile(logPath), foreign);
});

test('appendCodexSessionHistory appends after a trailing user-only open window', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const base = logForSession(await readFile(GOLDEN, 'utf8'), sessionId);
  const danglingTurnId = uuidv7(NOW + 100_000);
  const original = Buffer.from(`${base.trimEnd()}\n${[
    { type: 'event_msg', payload: { type: 'task_started', turn_id: danglingTurnId } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'unfinished target state' }],
        internal_chat_message_metadata_passthrough: { turn_id: danglingTurnId },
      },
    },
    // A real interrupted caller still has its user_message mirror; only the assistant is missing.
    { type: 'event_msg', payload: { type: 'user_message', message: 'unfinished target state' } },
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  await writeFile(logPath, original);

  const result = await appendCodexSessionHistory({
    sessionId,
    cwd: FIXTURE_CWD,
    turns: TURNS.slice(0, 1),
    persistPreparedAppend,
    homeDir,
  });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0]!.logicalId, TURNS[0]!.logicalId);

  const after = await readFile(logPath);
  assert.deepEqual(after.subarray(0, original.length), original, 'dangling open window bytes must be preserved as an exact prefix');
  const appended = after.subarray(original.length).toString('utf8').trimEnd().split('\n')
    .map((l) => JSON.parse(l) as Entry);
  assert.equal(appended.length, 5);
  assert.equal(appended[0]!.payload.type, 'task_started');
  assert.equal(appended[1]!.payload.role, 'user');
  assert.deepEqual(appended[2]!.payload, { type: 'user_message', message: TURNS[0]!.userText });
  assert.equal(appended[3]!.payload.role, 'assistant');
  assert.equal(appended[4]!.payload.type, 'task_complete');
  // No false completion: the seeded turn carries the caller's text, not the dangling user text,
  // and its lifecycle uses a fresh turn id, not the dangling one.
  assert.equal(codexText(appended[1]!), TURNS[0]!.userText);
  assert.equal(codexText(appended[3]!), TURNS[0]!.assistantText);
  assert.notEqual(eventTurnIdOf(appended[0]!), danglingTurnId);

  const read = await readCodexNativeSession({ backend: 'codex', sessionId, homeDir });
  assert.equal(read.turns.length, 3);
  assert.equal(read.turns[2]!.userText, TURNS[0]!.userText);
  assert.ok(read.turns.every((turn) => turn.userText !== 'unfinished target state'),
    'the dangling user-only window must never surface as a completed turn');
});

test('appendCodexSessionHistory appends after a trailing user+assistant open window it recovers as a turn', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const base = logForSession(await readFile(GOLDEN, 'utf8'), sessionId);
  const danglingTurnId = uuidv7(NOW + 100_000);
  const original = Buffer.from(`${base.trimEnd()}\n${[
    { type: 'event_msg', payload: { type: 'task_started', turn_id: danglingTurnId } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'unfinished target state' }],
        internal_chat_message_metadata_passthrough: { turn_id: danglingTurnId },
      },
    },
    // A real interrupted caller still has its user_message mirror.
    { type: 'event_msg', payload: { type: 'user_message', message: 'unfinished target state' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id: 'msg_0123456789abcdef0123456789abcdef',
        content: [{ type: 'output_text', text: 'half-written answer' }],
        internal_chat_message_metadata_passthrough: { turn_id: danglingTurnId },
      },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  await writeFile(logPath, original);

  // A trailing open window that ends on an assistant message is a completed turn under the
  // reader's trailing rule (exec omits the final task_complete), so it is present identically in
  // the before and candidate views and the append preserves the logical prefix.
  const result = await appendCodexSessionHistory({
    sessionId,
    cwd: FIXTURE_CWD,
    turns: TURNS.slice(0, 1),
    persistPreparedAppend,
    homeDir,
  });
  assert.equal(result.turns.length, 1);

  const after = await readFile(logPath);
  assert.deepEqual(after.subarray(0, original.length), original, 'dangling open window bytes must be preserved as an exact prefix');
  const read = await readCodexNativeSession({ backend: 'codex', sessionId, homeDir });
  assert.equal(read.turns.length, 4);
  assert.equal(read.turns[2]!.userText, 'unfinished target state');
  assert.equal(read.turns[2]!.assistantText, 'half-written answer');
  assert.equal(read.turns[2]!.nativeIds.completionId, danglingTurnId);
  assert.equal(read.turns[3]!.userText, TURNS[0]!.userText);
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
  const built = buildCodexHistoryEntries(logText, TURNS, NOW);
  assert.equal(built.lines.length, TURNS.length * 5);
  const appended = built.lines.map((l) => JSON.parse(l) as Entry);
  assert.deepEqual(responseItems(appended).map(codexText), EXPECTED_TEXT_ENTRIES.map((t) => t.text));
});

test('appendCodexSessionHistory reports a missing log as sessionLogNotFound', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  await assert.rejects(
    () => appendCodexSessionHistory({ sessionId: randomUUID(), cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, homeDir }),
    (error) => error instanceof OpenPError && error.exitCode === 41,
  );
});

test('appendCodexSessionHistory rejects an aborted signal before the write and leaves the log untouched', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionId = randomUUID();
  const logPath = join(homeDir, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const original = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId));
  await writeFile(logPath, original);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => appendCodexSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, homeDir, signal: controller.signal }),
    isAbortError,
  );
  assert.equal(sha256(await readFile(logPath)), sha256(original), 'log must be byte-identical after an aborted append');
});
