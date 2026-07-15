import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { isAbortError } from '../src/core/abort.js';
import type { SeedWriteTurn } from '../src/core/backend.js';
import { OpenPError } from '../src/core/errors.js';
import {
  appendOpenCodeSessionHistory,
  buildOpenCodeImport,
  buildOpenCodeImportDoc,
  cleanupOpenCodePreparedSessionHistoryAppend,
  combineOpenCodePrimaryAndCleanupFailure,
  createOpenCodeImportTempFile,
  prepareOpenCodeHistoryAppend,
  resolveOpenCodeImportTempRoot,
} from '../src/backends/opencode/history-writer.js';
import { createAbortError } from '../src/core/abort.js';
import { extractOpenCodeNativeTurns } from '../src/backends/opencode/native-reader.js';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';

const GOLDEN = join(process.cwd(), 'test/fixtures/seed/redacted-opencode-golden-export.json');
const NOW_MS = Date.UTC(2026, 6, 14, 12, 0, 0);
const TURNS: readonly SeedWriteTurn[] = [
  { logicalId: 'turn-1', userText: 'codename REDMOON', assistantText: 'noted one', contentDigest: 'digest-1', sourceNativeIds: null },
  { logicalId: 'turn-2', userText: 'month is March', assistantText: 'noted two', contentDigest: 'digest-2', sourceNativeIds: null },
];
const persistPreparedAppend = async (): Promise<void> => undefined;
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
  assert.deepEqual(createds, [NOW_MS - 4, NOW_MS - 3, NOW_MS - 2, NOW_MS - 1]);
  assert.equal(appended[3]!.info.time.completed, NOW_MS);

  // Round-trip: the re-extracted appended texts equal the input turns.
  assert.deepEqual(appended.map((m) => textParts(m)), EXPECTED_MESSAGES.map((t) => [t.text]));
});

test('OpenCode writer never clones synthetic or ignored text into portable seed turns', async () => {
  const before = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const user = before.messages.find((message: Msg) => message.info.role === 'user');
  const assistant = before.messages.find((message: Msg) => message.info.role === 'assistant');
  user.parts.find((part: Msg) => part.type === 'text').synthetic = true;
  user.parts.push({
    id: 'prt_f60012a90001AAAAAAAAAAAAAA',
    sessionID: before.info.id,
    messageID: user.info.id,
    type: 'text',
    text: 'portable user template',
    ignored: false,
  });
  assistant.parts.find((part: Msg) => part.type === 'text').ignored = true;
  assistant.parts.push({
    id: 'prt_f60012aa0001AAAAAAAAAAAAAA',
    sessionID: before.info.id,
    messageID: assistant.info.id,
    type: 'text',
    text: 'portable assistant template',
    synthetic: false,
  });

  const built = JSON.parse(buildOpenCodeImportDoc(JSON.stringify(before), [TURNS[0]!], NOW_MS, before.info.id));
  const appended = built.messages.slice(before.messages.length);
  assert.equal(appended.length, 2);
  for (const message of appended) {
    assert.equal(message.parts.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(message.parts[0], 'synthetic'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(message.parts[0], 'ignored'), false);
  }
  assert.equal(extractOpenCodeNativeTurns(JSON.stringify(built), built.info.id).at(-1)!.assistantText, TURNS[0]!.assistantText);
});

test('OpenCode writer never clones a tool-loop intermediate assistant as its terminal template', async () => {
  const before = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const user = structuredClone(before.messages[0]);
  user.info.id = 'msg_f6001c000001AAAAAAAAAAAAAA';
  user.info.time = { created: NOW_MS - 4 };
  user.parts = [{
    id: 'prt_f6001c000002AAAAAAAAAAAAAA',
    sessionID: before.info.id,
    messageID: user.info.id,
    type: 'text',
    text: 'tool-loop caller',
  }];
  const intermediate = structuredClone(before.messages[1]);
  intermediate.info.id = 'msg_f6001c000003AAAAAAAAAAAAAA';
  intermediate.info.parentID = user.info.id;
  intermediate.info.time = { created: NOW_MS - 3, completed: NOW_MS - 2 };
  intermediate.info.finish = 'stop';
  intermediate.info.variant = 'pending-tool-template-must-not-clone';
  intermediate.parts = [
    {
      id: 'prt_f6001c000004AAAAAAAAAAAAAA',
      sessionID: before.info.id,
      messageID: intermediate.info.id,
      type: 'text',
      text: 'intermediate text',
    },
    {
      id: 'prt_f6001c000005AAAAAAAAAAAAAA',
      sessionID: before.info.id,
      messageID: intermediate.info.id,
      type: 'tool',
      state: { status: 'completed' },
    },
  ];
  const terminal = structuredClone(before.messages[1]);
  terminal.info.id = 'msg_f6001c000006AAAAAAAAAAAAAA';
  terminal.info.parentID = user.info.id;
  terminal.info.time = { created: NOW_MS - 1, completed: NOW_MS };
  terminal.info.finish = 'stop';
  terminal.parts = [{
    id: 'prt_f6001c000007AAAAAAAAAAAAAA',
    sessionID: before.info.id,
    messageID: terminal.info.id,
    type: 'reasoning',
    text: 'terminal reasoning without portable answer text',
  }];
  before.messages.push(user, intermediate, terminal);

  assert.equal(extractOpenCodeNativeTurns(JSON.stringify(before), before.info.id).length, 1);
  const built = JSON.parse(prepareOpenCodeHistoryAppend(
    JSON.stringify(before),
    [TURNS[0]!],
    NOW_MS + 10,
    before.info.id,
  ).doc);
  const appendedAssistant = built.messages.at(-1);
  assert.equal(appendedAssistant.info.role, 'assistant');
  assert.equal(Object.prototype.hasOwnProperty.call(appendedAssistant.info, 'variant'), false);
});

test('OpenCode writer keeps terminal tool templates only for native non-pending exceptions', async () => {
  const base = JSON.parse(await readFile(GOLDEN, 'utf8'));
  for (const [variant, tool] of [
    ['provider-executed-template', { metadata: { providerExecuted: true }, state: { status: 'completed' } }],
    ['interrupted-orphan-template', { state: { status: 'error', metadata: { interrupted: true } } }],
  ] as const) {
    const before = structuredClone(base);
    const assistant = before.messages.at(-1);
    assistant.info.variant = variant;
    assistant.parts.push({
      id: variant === 'provider-executed-template'
        ? 'prt_f6001c100001AAAAAAAAAAAAAA'
        : 'prt_f6001c100002AAAAAAAAAAAAAA',
      sessionID: before.info.id,
      messageID: assistant.info.id,
      type: 'tool',
      ...tool,
    });
    const built = JSON.parse(prepareOpenCodeHistoryAppend(
      JSON.stringify(before),
      [TURNS[0]!],
      NOW_MS,
      before.info.id,
    ).doc);
    assert.equal(built.messages.at(-1).info.variant, variant);
  }
});

test('seeded OpenCode timestamps cannot interleave with an immediate native resume turn', async () => {
  const exportJson = await readFile(GOLDEN, 'utf8');
  const before = JSON.parse(exportJson);
  const built = JSON.parse(buildOpenCodeImportDoc(exportJson, TURNS, NOW_MS));
  const appended = built.messages.slice(before.messages.length);
  const immediateUserCreated = NOW_MS + 1;

  assert.ok(appended.every((message: Msg) => message.info.time.created < immediateUserCreated));
  assert.equal(appended.at(-1).info.time.completed, NOW_MS);

  const existingMax = Math.max(...before.messages.flatMap((message: Msg) => [
    message.info.time?.created,
    message.info.time?.completed,
  ]).filter(Number.isFinite));
  assertExitCode(
    () => buildOpenCodeImportDoc(exportJson, TURNS, existingMax + TURNS.length * 2),
    40,
  );

  const runtimeUser = structuredClone(appended[0]);
  runtimeUser.info.id = 'msg_f70000000000AAAAAAAAAAAAAA';
  runtimeUser.info.time = { created: NOW_MS + 1 };
  runtimeUser.parts[0].id = 'prt_f70000000001AAAAAAAAAAAAAA';
  runtimeUser.parts[0].messageID = runtimeUser.info.id;
  runtimeUser.parts[0].text = 'runtime user';
  const runtimeAssistant = structuredClone(appended[1]);
  runtimeAssistant.info.id = 'msg_f70000000002AAAAAAAAAAAAAA';
  runtimeAssistant.info.parentID = runtimeUser.info.id;
  runtimeAssistant.info.time = { created: NOW_MS + 2, completed: NOW_MS + 3 };
  runtimeAssistant.parts[0].id = 'prt_f70000000003AAAAAAAAAAAAAA';
  runtimeAssistant.parts[0].messageID = runtimeAssistant.info.id;
  runtimeAssistant.parts[0].text = 'runtime assistant';
  runtimeAssistant.parts[0].time = { start: NOW_MS + 2, end: NOW_MS + 3 };

  built.messages.push(runtimeUser, runtimeAssistant);
  built.messages.sort((left: Msg, right: Msg) => left.info.time.created - right.info.time.created);
  const turns = extractOpenCodeNativeTurns(JSON.stringify(built), built.info.id);
  assert.deepEqual(turns.slice(-3).map((turn) => [turn.userText, turn.assistantText]), [
    [TURNS[0]!.userText, TURNS[0]!.assistantText],
    [TURNS[1]!.userText, TURNS[1]!.assistantText],
    ['runtime user', 'runtime assistant'],
  ]);
});

test('buildOpenCodeImportDoc rejects an export whose info.id differs from the requested session id', async () => {
  const exportJson = await readFile(GOLDEN, 'utf8');
  const before = JSON.parse(exportJson);

  assert.doesNotThrow(() => buildOpenCodeImportDoc(exportJson, TURNS, NOW_MS, before.info.id));
  assertExitCode(() => buildOpenCodeImportDoc(exportJson, TURNS, NOW_MS, 'different-session'), 40);

  const wrongMessageOwner = structuredClone(before);
  wrongMessageOwner.messages[0].info.sessionID = 'different-session';
  assertExitCode(() => buildOpenCodeImportDoc(
    JSON.stringify(wrongMessageOwner),
    TURNS,
    NOW_MS,
    before.info.id,
  ), 40);

  const wrongPartMessage = structuredClone(before);
  wrongPartMessage.messages[0].parts[0].messageID = wrongPartMessage.messages[1].info.id;
  assertExitCode(() => buildOpenCodeImportDoc(
    JSON.stringify(wrongPartMessage),
    TURNS,
    NOW_MS,
    before.info.id,
  ), 40);
});

test('prepareOpenCodeHistoryAppend rejects a trailing incomplete target before import', async () => {
  const exportDoc = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const lastMessage = exportDoc.messages.at(-1);
  exportDoc.messages.push({
    info: {
      ...structuredClone(lastMessage.info),
      id: 'msg_f6001bd0a001AAAAAAAAAAAAAA',
      role: 'user',
      sessionID: exportDoc.info.id,
      time: { created: NOW_MS - 1 },
    },
    parts: [{
      ...structuredClone(lastMessage.parts[0]),
      id: 'prt_f6001bd0b001AAAAAAAAAAAAAA',
      messageID: 'msg_f6001bd0a001AAAAAAAAAAAAAA',
      sessionID: exportDoc.info.id,
      type: 'text',
      text: 'unfinished',
    }],
  });

  assertExitCode(() => prepareOpenCodeHistoryAppend(
    JSON.stringify(exportDoc),
    TURNS.slice(0, 1),
    NOW_MS,
    exportDoc.info.id,
  ), 40);
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
      { info: { role: 'assistant', id: 'msg_ffffffffffffCCCCCCCCCCCCCC', finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'yo', id: 'prt_ffffffffffffDDDDDDDDDDDDDD' }] },
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
      { info: { role: 'assistant', id: `msg_${nearMaxSegment}CCCCCCCCCCCCCC`, finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'yo', id: `prt_${nearMaxSegment}DDDDDDDDDDDDDD` }] },
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

test('writer rejects malformed ids even when other native ids remain valid', async () => {
  const original = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const corruptions: readonly ((doc: any) => void)[] = [
    (doc) => { doc.messages[0].info.id = 'msg_not-native'; },
    (doc) => { delete doc.messages[0].parts[0].id; },
    (doc) => { doc.messages[1].info.id = doc.messages[0].info.id; },
    (doc) => { doc.messages[1].parts[0].id = doc.messages[0].parts[0].id; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(original);
    corrupt(candidate);
    assertExitCode(() => buildOpenCodeImportDoc(JSON.stringify(candidate), TURNS, NOW_MS), 40);
  }
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
  const sessionId = 'ses_private_temp';
  const cleanupToken = randomUUID();
  const temp = await createOpenCodeImportTempFile({ doc, sessionId, cleanupToken, stateRoot });
  try {
    assert.equal(relative(stateRoot, temp.path).startsWith('..'), true);
    assert.equal(await readFile(temp.path, 'utf8'), doc);
    assert.equal((await stat(temp.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(temp.path))).mode & 0o777, 0o700);
    assert.equal(dirname(temp.path).includes(sessionId), false, 'the locator must not disclose the session id');
    assert.equal(dirname(temp.path).endsWith(cleanupToken), true);
    assert.deepEqual(await readdir(stateRoot), []);
  } finally {
    await temp.cleanup();
  }
  await assert.rejects(() => readFile(temp.path), (error: any) => error?.code === 'ENOENT');
  await temp.cleanup();
});

test('OpenCode cleanup diagnostics preserve the primary failure exit semantics', () => {
  const cleanup = new Error('cleanup denied');
  const backendExit = combineOpenCodePrimaryAndCleanupFailure(
    new OpenPError('import failed', 12),
    cleanup,
  );
  assert.ok(backendExit instanceof OpenPError);
  assert.equal(backendExit.exitCode, 12);
  assert.match(backendExit.message, /import failed.*cleanup denied/);

  const protocol = combineOpenCodePrimaryAndCleanupFailure(
    new OpenPError('session mismatch', 40),
    cleanup,
  );
  assert.ok(protocol instanceof OpenPError);
  assert.equal(protocol.exitCode, 40);

  const aborted = combineOpenCodePrimaryAndCleanupFailure(
    createAbortError('import aborted', 'partial reasoning'),
    cleanup,
  );
  assert.equal(aborted.name, 'AbortError');
  assert.equal((aborted as Error & { code?: string }).code, 'ABORT_ERR');

  const writeFailure = combineOpenCodePrimaryAndCleanupFailure(
    new Error('write failed'),
    cleanup,
  );
  assert.ok(writeFailure instanceof OpenPError);
  assert.equal(writeFailure.exitCode, 11);
});

test('OpenCode cleanup locator is independent of ambient TMPDIR changes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-stable-temp-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-stable-temp-state-'));
  const firstTmp = await mkdtemp(join(tmpdir(), 'openp-opencode-ambient-a-'));
  const secondTmp = await mkdtemp(join(tmpdir(), 'openp-opencode-ambient-b-'));
  const previous = { TMPDIR: process.env.TMPDIR, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.TMPDIR = firstTmp;
  process.env.XDG_STATE_HOME = stateHome;
  const sessionId = 'ses_stable_cleanup';
  const cleanupToken = randomUUID();
  try {
    const stateRoot = resolveOpenPStateRoot(cwd, process.env);
    const temp = await createOpenCodeImportTempFile({
      doc: '{"transcript":"must be cleaned from the stable root"}',
      sessionId,
      cleanupToken,
      stateRoot,
    });
    assert.equal(relative(firstTmp, temp.path).startsWith('..'), true);
    process.env.TMPDIR = secondTmp;
    await cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token: cleanupToken });
    await assert.rejects(() => stat(dirname(temp.path)), (error: any) => error?.code === 'ENOENT');
    await cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token: cleanupToken });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenCode cleanup recovers a crash-created private locator before chmod completed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-mode-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-mode-state-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const sessionId = 'ses_cleanup_private_mode';
  const cleanupToken = randomUUID();
  try {
    const stateRoot = resolveOpenPStateRoot(cwd, process.env);
    const temp = await createOpenCodeImportTempFile({
      doc: '{"transcript":"partial private import"}',
      sessionId,
      cleanupToken,
      stateRoot,
    });
    const tokenDir = dirname(temp.path);
    await chmod(temp.path, 0o000);
    await chmod(tokenDir, 0o000);

    await cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token: cleanupToken });

    await assert.rejects(() => stat(tokenDir), (error: any) => error?.code === 'ENOENT');
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test('OpenCode cleanup validates a retained import file mode and symlink before unlinking it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-file-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-file-state-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    const stateRoot = resolveOpenPStateRoot(cwd, process.env);

    const wrongModeToken = randomUUID();
    const wrongModeTemp = await createOpenCodeImportTempFile({
      doc: '{"transcript":"retained import"}',
      sessionId: 'ses_cleanup_wrong_file_mode',
      cleanupToken: wrongModeToken,
      stateRoot,
    });
    await chmod(wrongModeTemp.path, 0o644);
    await assert.rejects(
      () => cleanupOpenCodePreparedSessionHistoryAppend({
        sessionId: 'ses_cleanup_wrong_file_mode',
        cwd,
        token: wrongModeToken,
      }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.equal(await readFile(wrongModeTemp.path, 'utf8'), '{"transcript":"retained import"}');
    await chmod(wrongModeTemp.path, 0o600);
    await cleanupOpenCodePreparedSessionHistoryAppend({
      sessionId: 'ses_cleanup_wrong_file_mode',
      cwd,
      token: wrongModeToken,
    });

    const symlinkToken = randomUUID();
    const symlinkTemp = await createOpenCodeImportTempFile({
      doc: '{"transcript":"replace with symlink"}',
      sessionId: 'ses_cleanup_symlink_file',
      cleanupToken: symlinkToken,
      stateRoot,
    });
    const external = join(stateHome, 'external-sentinel');
    await writeFile(external, 'keep');
    await unlink(symlinkTemp.path);
    await symlink(external, symlinkTemp.path);
    await assert.rejects(
      () => cleanupOpenCodePreparedSessionHistoryAppend({
        sessionId: 'ses_cleanup_symlink_file',
        cwd,
        token: symlinkToken,
      }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.equal(await readFile(external, 'utf8'), 'keep');
    await unlink(symlinkTemp.path);
    await cleanupOpenCodePreparedSessionHistoryAppend({
      sessionId: 'ses_cleanup_symlink_file',
      cwd,
      token: symlinkToken,
    });
    assert.equal(await readFile(external, 'utf8'), 'keep');
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test('OpenCode prepared cleanup rejects unsafe identities without touching unrelated files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-identity-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-identity-state-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const sentinel = join(stateHome, 'sentinel');
  await writeFile(sentinel, 'keep');
  try {
    for (const [sessionId, token] of [
      ['unsafe/../session', randomUUID()],
      ['ses_safe', '../../sentinel'],
    ] as const) {
      await assert.rejects(
        () => cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token }),
        (error) => error instanceof OpenPError && error.exitCode === 40,
      );
    }
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
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
      () => appendOpenCodeSessionHistory({
        sessionId: 'ses_abort',
        cwd,
        turns: TURNS,
        persistPreparedAppend,
        signal: controller.signal,
      }),
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

test('OpenCode durability barrier runs after export preflight but before import temp creation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-barrier-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-barrier-state-'));
  const tempRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-barrier-temp-'));
  const binDir = await mkdtemp(join(tmpdir(), 'openp-opencode-barrier-bin-'));
  const binPath = join(binDir, 'opencode');
  await writeFile(binPath, `#!/bin/sh\n/bin/cat ${JSON.stringify(GOLDEN)}\n`, { mode: 0o700 });
  await chmod(binPath, 0o700);
  const previous = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  process.env.PATH = `${binDir}:${previous.PATH ?? '/usr/bin:/bin'}`;
  process.env.TMPDIR = tempRoot;
  process.env.XDG_STATE_HOME = stateHome;
  let preparationCalls = 0;
  let cleanupToken = '';
  const barrierFailure = new OpenPError('injected journal failure', 20);
  try {
    await assert.rejects(
      () => appendOpenCodeSessionHistory({
        sessionId: 'ses_openpseedtest0000000002',
        cwd,
        turns: TURNS,
        persistPreparedAppend: async (prepared) => {
          preparationCalls += 1;
          cleanupToken = prepared.cleanupToken ?? '';
          assert.match(cleanupToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          assert.equal(prepared.turns.length, TURNS.length);
          assert.deepEqual(await readdir(tempRoot), []);
          const stateRoot = resolveOpenPStateRoot(cwd, process.env);
          const fixedTempRoot = await resolveOpenCodeImportTempRoot(stateRoot);
          assert.equal(
            (await readdir(fixedTempRoot)).some((entry) => entry.endsWith(cleanupToken)),
            false,
            'the prepared barrier must run before the transcript temp directory exists',
          );
          throw barrierFailure;
        },
      }),
      (error) => error === barrierFailure,
    );
    assert.equal(preparationCalls, 1);
    assert.deepEqual(await readdir(tempRoot), []);
    const fixedTempRoot = await resolveOpenCodeImportTempRoot(resolveOpenPStateRoot(cwd, process.env));
    assert.equal((await readdir(fixedTempRoot)).some((entry) => entry.endsWith(cleanupToken)), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenCode Writer immediately cleans a committed import locator and provider cleanup is idempotent', async () => {
  const sessionId = 'ses_openpseedtest0000000002';
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-success-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-success-state-'));
  const binDir = await mkdtemp(join(tmpdir(), 'openp-opencode-success-bin-'));
  const binPath = join(binDir, 'opencode');
  await writeFile(binPath, [
    '#!/bin/sh',
    'case "$1" in',
    `  export) /bin/cat ${JSON.stringify(GOLDEN)} ;;`,
    `  import) test -f "$2" || exit 91; echo "Imported session: ${sessionId}" ;;`,
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(binPath, 0o700);
  const previous = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.PATH = `${binDir}:${previous.PATH ?? '/usr/bin:/bin'}`;
  process.env.XDG_STATE_HOME = stateHome;
  let cleanupToken = '';
  try {
    const result = await appendOpenCodeSessionHistory({
      sessionId,
      cwd,
      turns: TURNS,
      persistPreparedAppend: async (prepared) => {
        cleanupToken = prepared.cleanupToken ?? '';
        assert.match(cleanupToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const fixedTempRoot = await resolveOpenCodeImportTempRoot(resolveOpenPStateRoot(cwd, process.env));
        assert.equal((await readdir(fixedTempRoot)).some((entry) => entry.endsWith(cleanupToken)), false);
      },
    });
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.postWriteCleanupFailure, undefined);
    const fixedTempRoot = await resolveOpenCodeImportTempRoot(resolveOpenPStateRoot(cwd, process.env));
    assert.equal(
      (await readdir(fixedTempRoot)).some((entry) => entry.endsWith(cleanupToken)),
      false,
      'catchable successful commit must be cleaned before the Writer returns',
    );
    await cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token: cleanupToken });
    await cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token: cleanupToken });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenCode Writer immediately cleans the locator after a catchable import failure', async () => {
  const sessionId = 'ses_openpseedtest0000000002';
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-failure-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-failure-state-'));
  const binDir = await mkdtemp(join(tmpdir(), 'openp-opencode-failure-bin-'));
  const binPath = join(binDir, 'opencode');
  await writeFile(binPath, [
    '#!/bin/sh',
    'case "$1" in',
    `  export) /bin/cat ${JSON.stringify(GOLDEN)} ;;`,
    '  import) exit 23 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(binPath, 0o700);
  const previous = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.PATH = `${binDir}:${previous.PATH ?? '/usr/bin:/bin'}`;
  process.env.XDG_STATE_HOME = stateHome;
  let cleanupToken = '';
  try {
    await assert.rejects(
      () => appendOpenCodeSessionHistory({
        sessionId,
        cwd,
        turns: TURNS.slice(0, 1),
        persistPreparedAppend: async (prepared) => {
          cleanupToken = prepared.cleanupToken ?? '';
        },
      }),
      (error) => error instanceof OpenPError && error.exitCode === 12,
    );
    const fixedTempRoot = await resolveOpenCodeImportTempRoot(resolveOpenPStateRoot(cwd, process.env));
    assert.equal((await readdir(fixedTempRoot)).some((entry) => entry.endsWith(cleanupToken)), false);
    await cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token: cleanupToken });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenCode Writer preserves committed mappings when immediate controlled cleanup fails', async () => {
  const sessionId = 'ses_openpseedtest0000000002';
  const cwd = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-fail-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-fail-state-'));
  const binDir = await mkdtemp(join(tmpdir(), 'openp-opencode-cleanup-fail-bin-'));
  const binPath = join(binDir, 'opencode');
  await writeFile(binPath, [
    '#!/bin/sh',
    'case "$1" in',
    `  export) /bin/cat ${JSON.stringify(GOLDEN)} ;;`,
    `  import) /bin/chmod 0755 "$(/usr/bin/dirname "$2")"; echo "Imported session: ${sessionId}" ;;`,
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(binPath, 0o700);
  const previous = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.PATH = `${binDir}:${previous.PATH ?? '/usr/bin:/bin'}`;
  process.env.XDG_STATE_HOME = stateHome;
  let cleanupToken = '';
  try {
    const result = await appendOpenCodeSessionHistory({
      sessionId,
      cwd,
      turns: TURNS.slice(0, 1),
      persistPreparedAppend: async (prepared) => {
        cleanupToken = prepared.cleanupToken ?? '';
      },
    });
    assert.equal(result.turns.length, 1);
    assert.match(result.postWriteCleanupFailure?.message ?? '', /cleanup failed after native commit/);
    assert.equal(Object.prototype.hasOwnProperty.call(result.postWriteCleanupFailure ?? {}, 'details'), false);
    const fixedTempRoot = await resolveOpenCodeImportTempRoot(resolveOpenPStateRoot(cwd, process.env));
    const locatorName = (await readdir(fixedTempRoot)).find((entry) => entry.endsWith(cleanupToken));
    assert.ok(locatorName, 'failed immediate cleanup must retain the controlled locator for core retry');
    const locatorDir = join(fixedTempRoot, locatorName);
    assert.equal(await readFile(join(locatorDir, 'import.json'), 'utf8').then((value) => value.length > 0), true);
    await chmod(locatorDir, 0o700);
    await cleanupOpenCodePreparedSessionHistoryAppend({ sessionId, cwd, token: cleanupToken });
    await assert.rejects(() => stat(locatorDir), (error: any) => error?.code === 'ENOENT');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
