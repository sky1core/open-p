import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { isAbortError } from '../src/core/abort.js';
import type { SeedWriteTurn } from '../src/core/backend.js';
import { OpenPError } from '../src/core/errors.js';
import {
  appendOpenCodeSessionHistory,
  buildOpenCodeImport,
  buildOpenCodeImportDoc,
  createOpenCodeImportTempFile,
} from '../src/backends/opencode/history-writer.js';

const GOLDEN = join(process.cwd(), 'test/fixtures/seed/redacted-opencode-golden-export.json');
const NOW_MS = Date.UTC(2026, 6, 14, 12, 0, 0);
const TURNS: readonly SeedWriteTurn[] = [
  { logicalId: 'turn-1', userText: 'codename REDMOON', assistantText: 'noted one', contentDigest: 'digest-1', sourceNativeIds: null },
  { logicalId: 'turn-2', userText: 'month is March', assistantText: 'noted two', contentDigest: 'digest-2', sourceNativeIds: null },
];
const EXPECTED_MESSAGES = TURNS.flatMap((turn) => [
  { role: 'user', text: turn.userText },
  { role: 'assistant', text: turn.assistantText },
]);
const MSG_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const PRT_RE = /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

type Msg = Record<string, any>;

// Extracts the native 12-hex time segment of a msg_/prt_ id; asserts native format on the way, so
// this also pins the fixture ids to the real OpenCode id shape.
function idSegment(id: string): bigint {
  const segment = id.slice(4, 16);
  assert.match(segment, /^[0-9a-f]{12}$/, `id ${id} must carry a native 12-hex time segment`);
  return BigInt(`0x${segment}`);
}

function allIds(messages: readonly Msg[]): string[] {
  return messages.flatMap((m) => [m.info.id, ...m.parts.map((p: any) => p.id)]);
}

function textParts(message: Msg): string[] {
  return message.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text);
}

function assertExitCode(fn: () => unknown, code: number): void {
  assert.throws(fn, (error) => error instanceof OpenPError && error.exitCode === code);
}

test('buildOpenCodeImportDoc appends text-only turns and preserves the existing session', async () => {
  const exportJson = await readFile(GOLDEN, 'utf8');
  const before = JSON.parse(exportJson);
  const existingCount = before.messages.length;
  const existingMsgIds = new Set<string>(before.messages.map((m: Msg) => m.info.id));
  const existingPrtIds = new Set<string>(
    before.messages.flatMap((m: Msg) => m.parts.map((p: any) => p.id)),
  );

  const doc = JSON.parse(buildOpenCodeImportDoc(exportJson, TURNS, NOW_MS));

  // info.id (the import upsert key) is never changed.
  assert.equal(doc.info.id, before.info.id);
  // Existing messages are preserved verbatim, in order.
  assert.deepEqual(doc.messages.slice(0, existingCount), before.messages);

  const appended: Msg[] = doc.messages.slice(existingCount);
  assert.equal(appended.length, EXPECTED_MESSAGES.length);

  appended.forEach((message, index) => {
    const turn = EXPECTED_MESSAGES[index]!;
    assert.equal(message.info.role, turn.role);
    // Exactly one text-only part carrying the turn text.
    assert.equal(message.parts.length, 1);
    assert.equal(message.parts[0].type, 'text');
    assert.equal(message.parts[0].text, turn.text);
    assert.match(message.info.id, MSG_RE);
    assert.match(message.parts[0].id, PRT_RE);
    assert.equal(message.parts[0].messageID, message.info.id);
  });

  // Fresh, unique msg_/prt_ ids that do not collide with the existing session.
  const newMsgIds = appended.map((m) => m.info.id as string);
  const newPrtIds = appended.map((m) => m.parts[0].id as string);
  assert.equal(new Set(newMsgIds).size, newMsgIds.length);
  assert.equal(new Set(newPrtIds).size, newPrtIds.length);
  for (const id of newMsgIds) {
    assert.equal(existingMsgIds.has(id), false);
  }
  for (const id of newPrtIds) {
    assert.equal(existingPrtIds.has(id), false);
  }

  // Assistant turns parent onto the immediately preceding appended message; user turns carry none.
  assert.equal(appended[1]!.info.parentID, appended[0]!.info.id);
  assert.equal(appended[3]!.info.parentID, appended[2]!.info.id);
  assert.equal(Object.prototype.hasOwnProperty.call(appended[0]!.info, 'parentID'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(appended[2]!.info, 'parentID'), false);

  // created is strictly increasing; assistant completed is after its own created.
  const createds = appended.map((m) => m.info.time.created as number);
  for (let i = 1; i < createds.length; i += 1) {
    assert.ok(createds[i]! > createds[i - 1]!);
  }
  assert.ok(appended[1]!.info.time.completed > appended[1]!.info.time.created);
  assert.ok(appended[3]!.info.time.completed > appended[3]!.info.time.created);

  // Round-trip: the re-extracted appended texts equal the input turns.
  assert.deepEqual(appended.map((m) => textParts(m)), EXPECTED_MESSAGES.map((t) => [t.text]));
});

test('seed ids continue the export id ordering with monotonic hex time segments', async () => {
  const exportJson = await readFile(GOLDEN, 'utf8');
  const before = JSON.parse(exportJson);
  // Also validates the fixture itself: every existing id must be native-format (12-hex segment).
  const maxExisting = allIds(before.messages).map(idSegment).reduce((a, b) => (a > b ? a : b));

  const doc = JSON.parse(buildOpenCodeImportDoc(exportJson, TURNS, NOW_MS));
  const appended: Msg[] = doc.messages.slice(before.messages.length);

  // Segments strictly greater than every existing id and strictly increasing in allocation order
  // (msg, its part, next msg, ...): this is what keeps opencode's id-based message sort stable, so
  // seeded turns land after existing messages and in seed order instead of shuffling on resume.
  const seedIds = appended.flatMap((m) => [m.info.id as string, m.parts[0].id as string]);
  let previous = maxExisting;
  for (const id of seedIds) {
    const segment = idSegment(id);
    assert.ok(segment > maxExisting, `${id} must sort after every existing id`);
    assert.ok(segment > previous, `${id} must be monotonically increasing within the seed batch`);
    previous = segment;
  }
});

test('seeded text parts never keep the template time and agree with their message info.time', async () => {
  const exportJson = await readFile(GOLDEN, 'utf8');
  const before = JSON.parse(exportJson);
  // Pin the fixture shapes this test relies on: assistant text parts natively carry a time object,
  // user text parts carry none.
  const templateAssistantTime = [...before.messages].reverse()
    .find((m: Msg) => m.info.role === 'assistant')!
    .parts.find((p: any) => p.type === 'text').time;
  assert.ok(templateAssistantTime, 'fixture assistant text part must carry a template time');
  const templateUserPart = [...before.messages].reverse()
    .find((m: Msg) => m.info.role === 'user')!
    .parts.find((p: any) => p.type === 'text');
  assert.equal(Object.prototype.hasOwnProperty.call(templateUserPart, 'time'), false);

  const doc = JSON.parse(buildOpenCodeImportDoc(exportJson, TURNS, NOW_MS));
  const appended: Msg[] = doc.messages.slice(before.messages.length);
  assert.equal(appended.length, EXPECTED_MESSAGES.length);
  for (const message of appended) {
    const part = message.parts[0];
    if (message.info.role === 'user') {
      // The user template has no part-level time, so seeded user parts must not invent one.
      assert.equal(Object.prototype.hasOwnProperty.call(part, 'time'), false);
    } else {
      // Regenerated from this message's own info.time — the template's old timestamps must not
      // survive into a seeded part.
      assert.deepEqual(part.time, { start: message.info.time.created, end: message.info.time.completed });
      assert.notDeepEqual(part.time, templateAssistantTime);
    }
  }
});

test('a seed batch that would push the 12-hex id segment past its range fails closed', () => {
  // maxExisting is already the largest 12-hex value, so the very first seed id would need a 13th
  // hex digit — that breaks the native id shape (and opencode's id ordering), hence exit 40.
  const atMax = JSON.stringify({
    info: { id: 'ses_x' },
    messages: [
      { info: { role: 'user', id: 'msg_fffffffffffeAAAAAAAAAAAAAA' }, parts: [{ type: 'text', text: 'hi', id: 'prt_fffffffffffeBBBBBBBBBBBBBB' }] },
      { info: { role: 'assistant', id: 'msg_ffffffffffffCCCCCCCCCCCCCC' }, parts: [{ type: 'text', text: 'yo', id: 'prt_ffffffffffffDDDDDDDDDDDDDD' }] },
    ],
  });
  assertExitCode(() => buildOpenCodeImportDoc(atMax, TURNS, NOW_MS), 40);

  // Boundary: landing exactly on the max segment is still valid (guards against an off-by-one).
  // TURNS allocates 8 ids (4 messages + 4 parts), so a max of MAX-8 ends exactly at MAX.
  const nearMaxSegment = (0xffffffffffffn - 8n).toString(16).padStart(12, '0');
  const nearMax = JSON.stringify({
    info: { id: 'ses_x' },
    messages: [
      { info: { role: 'user', id: `msg_${nearMaxSegment}AAAAAAAAAAAAAA` }, parts: [{ type: 'text', text: 'hi', id: `prt_${nearMaxSegment}BBBBBBBBBBBBBB` }] },
      { info: { role: 'assistant', id: `msg_${nearMaxSegment}CCCCCCCCCCCCCC` }, parts: [{ type: 'text', text: 'yo', id: `prt_${nearMaxSegment}DDDDDDDDDDDDDD` }] },
    ],
  });
  const doc = JSON.parse(buildOpenCodeImportDoc(nearMax, TURNS, NOW_MS));
  const lastPartId = doc.messages.at(-1).parts[0].id as string;
  assert.equal(lastPartId.slice(4, 16), 'ffffffffffff');
});

test('an export whose ids lack native time segments is a protocol violation', () => {
  // Templates exist, but no id carries the 12-hex segment, so ordering-safe seed ids cannot be
  // constructed and the writer must fail closed instead of emitting ids that shuffle the session.
  const nonNative = JSON.stringify({
    info: { id: 'ses_x' },
    messages: [
      { info: { role: 'user', id: 'msg_a' }, parts: [{ type: 'text', text: 'hi', id: 'prt_a' }] },
      { info: { role: 'assistant', id: 'msg_b' }, parts: [{ type: 'text', text: 'yo', id: 'prt_b' }] },
    ],
  });
  assertExitCode(() => buildOpenCodeImportDoc(nonNative, TURNS, NOW_MS), 40);
});

test('near-native malformed ids do not count as native and fail closed', () => {
  // A 12-hex head alone is not a native id: without the exact 14-char base62 tail (or with a
  // non-base62 tail / uppercase hex segment) the id must not seed the ordering counter, and an
  // export containing only such ids fails closed with 40 instead of building a bogus ordering base.
  const docWithIds = (ids: readonly [string, string, string, string]) => JSON.stringify({
    info: { id: 'ses_x' },
    messages: [
      { info: { role: 'user', id: ids[0] }, parts: [{ type: 'text', text: 'hi', id: ids[1] }] },
      { info: { role: 'assistant', id: ids[2] }, parts: [{ type: 'text', text: 'yo', id: ids[3] }] },
    ],
  });
  // Tail missing entirely.
  assertExitCode(() => buildOpenCodeImportDoc(
    docWithIds(['msg_000000000001', 'prt_000000000002', 'msg_000000000003', 'prt_000000000004']),
    TURNS,
    NOW_MS,
  ), 40);
  // Tail too short (13 chars).
  assertExitCode(() => buildOpenCodeImportDoc(
    docWithIds([
      'msg_000000000001AAAAAAAAAAAAA', 'prt_000000000002AAAAAAAAAAAAA',
      'msg_000000000003AAAAAAAAAAAAA', 'prt_000000000004AAAAAAAAAAAAA',
    ]),
    TURNS,
    NOW_MS,
  ), 40);
  // Tail of the right length but not base62.
  assertExitCode(() => buildOpenCodeImportDoc(
    docWithIds([
      'msg_000000000001AAAAAAAAAAAAA!', 'prt_000000000002AAAAAAAAAAAAA!',
      'msg_000000000003AAAAAAAAAAAAA!', 'prt_000000000004AAAAAAAAAAAAA!',
    ]),
    TURNS,
    NOW_MS,
  ), 40);
  // Segment with uppercase hex is not the native lowercase shape.
  assertExitCode(() => buildOpenCodeImportDoc(
    docWithIds([
      'msg_00000000000FAAAAAAAAAAAAAA', 'prt_00000000000FAAAAAAAAAAAAAA',
      'msg_00000000000EAAAAAAAAAAAAAA', 'prt_00000000000DAAAAAAAAAAAAAA',
    ]),
    TURNS,
    NOW_MS,
  ), 40);
});

test('buildOpenCodeImport returns target native ids for each seeded pair', async () => {
  const exportJson = await readFile(GOLDEN, 'utf8');
  const before = JSON.parse(exportJson);
  const built = buildOpenCodeImport(exportJson, TURNS, NOW_MS);
  const doc = JSON.parse(built.doc);
  const appended: Msg[] = doc.messages.slice(before.messages.length);

  assert.equal(built.written.length, TURNS.length);
  assert.equal(appended.length, EXPECTED_MESSAGES.length);
  assert.deepEqual(built.written.map((turn) => turn.logicalId), TURNS.map((turn) => turn.logicalId));
  assert.deepEqual(built.written.map((turn) => turn.contentDigest), TURNS.map((turn) => turn.contentDigest));
  assert.deepEqual(built.written.map((turn) => turn.nativeIds), [
    {
      userId: appended[0]!.info.id,
      assistantIds: [appended[1]!.info.id],
      completionId: appended[1]!.info.id,
    },
    {
      userId: appended[2]!.info.id,
      assistantIds: [appended[3]!.info.id],
      completionId: appended[3]!.info.id,
    },
  ]);
});

test('buildOpenCodeImportDoc rejects an export without user/assistant text templates', () => {
  const emptyMessages = JSON.stringify({ info: { id: 'ses_x' }, messages: [] });
  assertExitCode(() => buildOpenCodeImportDoc(emptyMessages, TURNS, NOW_MS), 40);

  // Messages exist but carry no `text` part (only reasoning), so there is no clone template.
  const noTextParts = JSON.stringify({
    info: { id: 'ses_x' },
    messages: [
      { info: { role: 'user', id: 'msg_a' }, parts: [{ type: 'reasoning', text: 'hmm' }] },
      { info: { role: 'assistant', id: 'msg_b' }, parts: [{ type: 'reasoning', text: 'hmm' }] },
    ],
  });
  assertExitCode(() => buildOpenCodeImportDoc(noTextParts, TURNS, NOW_MS), 40);

  // A user text template but no assistant text template (and vice versa) is still a violation.
  const onlyUser = JSON.stringify({
    info: { id: 'ses_x' },
    messages: [{ info: { role: 'user', id: 'msg_a' }, parts: [{ type: 'text', text: 'hi' }] }],
  });
  assertExitCode(() => buildOpenCodeImportDoc(onlyUser, TURNS, NOW_MS), 40);
});

test('buildOpenCodeImportDoc rejects unparseable or non-message export output', () => {
  assertExitCode(() => buildOpenCodeImportDoc('not json{', TURNS, NOW_MS), 40);
  assertExitCode(() => buildOpenCodeImportDoc(JSON.stringify({ info: {}, messages: 'nope' }), TURNS, NOW_MS), 40);
  assertExitCode(() => buildOpenCodeImportDoc(JSON.stringify([1, 2, 3]), TURNS, NOW_MS), 40);
});

test('OpenCode import documents use a private OS temp file outside open-p state', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-temp-state-'));
  const doc = JSON.stringify({ transcript: 'sensitive seed text' });
  const temp = await createOpenCodeImportTempFile(doc, stateRoot);
  try {
    assert.equal(relative(stateRoot, temp.path).startsWith('..'), true);
    assert.equal(await readFile(temp.path, 'utf8'), doc);
    assert.equal((await stat(temp.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(stateRoot), []);
  } finally {
    await temp.cleanup();
  }
  await assert.rejects(() => readFile(temp.path), (error: any) => error?.code === 'ENOENT');
});

test('OpenCode import rejects TMPDIR when it resolves inside open-p state', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-contained-temp-state-'));
  const containedTempRoot = join(stateRoot, 'cache');
  await mkdir(containedTempRoot);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = containedTempRoot;
  try {
    await assert.rejects(
      () => createOpenCodeImportTempFile('{"transcript":"must not land in state"}', stateRoot),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.deepEqual(await readdir(containedTempRoot), []);
  } finally {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
  }
});

test('appendOpenCodeSessionHistory rejects a pre-aborted signal before any child process or state', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-abort-state-'));
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-abort-cwd-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => appendOpenCodeSessionHistory({ sessionId: 'ses_abort', cwd, turns: TURNS, signal: controller.signal }),
      isAbortError,
    );
    // throwIfAborted precedes env setup and any spawn, so no isolated env (and no child) is created.
    assert.deepEqual(await readdir(stateRoot), []);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
  }
});
