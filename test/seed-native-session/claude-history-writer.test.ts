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
  appendClaudeCodeSessionHistory,
  buildClaudeCodeHistoryEntries,
} from '../../src/backends/claude/history-writer.js';
import {
  claudeNativeStateDigest,
  extractClaudeNativeTurns,
  readClaudeCodeNativeSession,
} from '../../src/backends/claude/native-reader.js';
import { resolveClaudeCodeSessionLogPath } from '../../src/backends/claude/session-log.js';
import { installFileDriftOnNextSync } from '../helpers/native-file-sync-fault.js';

const GOLDEN = join(import.meta.dirname, 'fixture-claude-golden.jsonl');
const BOOTSTRAP = join(import.meta.dirname, 'fixture-claude-bootstrap.jsonl');
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Entry = Record<string, any>;

function fixtureEntries(logText: string): Entry[] {
  return logText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function logForSession(logText: string, sessionId: string, cwd: string): string {
  return fixtureEntries(logText).map((entry) => {
    const copy = structuredClone(entry);
    if (Object.prototype.hasOwnProperty.call(copy, 'sessionId')) copy.sessionId = sessionId;
    if (Object.prototype.hasOwnProperty.call(copy, 'session_id')) copy.session_id = sessionId;
    if (typeof copy.cwd === 'string') copy.cwd = cwd;
    return JSON.stringify(copy);
  }).join('\n') + '\n';
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
  const original = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId, FIXTURE_CWD));
  await writeFile(logPath, original);
  const beforeSha = createHash('sha256').update(original).digest('hex');
  let preparationCalls = 0;
  let preparedCandidateDigest: string | null = null;

  await appendClaudeCodeSessionHistory({
    sessionId,
    cwd: FIXTURE_CWD,
    turns: TURNS,
    configDir,
    persistPreparedAppend: async (prepared) => {
      preparationCalls += 1;
      preparedCandidateDigest = prepared.candidateNativeStateDigest;
      assert.equal(prepared.turns.length, TURNS.length);
      assert.deepEqual(await readFile(logPath), original, 'durability barrier must precede native mutation');
    },
  });

  const after = await readFile(logPath);
  assert.equal(preparationCalls, 1);
  assert.equal(claudeNativeStateDigest(after), preparedCandidateDigest);
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

test('Claude production reader confirms a stable file-backed settlement snapshot', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-settlement-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const bytes = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId, FIXTURE_CWD));
  await writeFile(logPath, bytes);

  const read = await readClaudeCodeNativeSession({
    backend: 'claude',
    sessionId,
    cwd: FIXTURE_CWD,
    configDir,
    mode: 'settlement',
  });

  assert.equal(read.nativeStateDigest, claudeNativeStateDigest(bytes));
  assert.equal(read.turns.length > 0, true);
});

test('Claude production reader rejects first-read drift only in settlement mode', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-settlement-drift-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const bytes = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId, FIXTURE_CWD));
  await writeFile(logPath, bytes);
  const fault = await installFileDriftOnNextSync(logPath, Buffer.concat([bytes, Buffer.from('\n')]));
  try {
    await assert.doesNotReject(() => readClaudeCodeNativeSession({
      backend: 'claude', sessionId, cwd: FIXTURE_CWD, configDir, mode: 'logical',
    }));
    assert.equal(fault.wasTriggered(), false);
    await assert.rejects(
      () => readClaudeCodeNativeSession({
        backend: 'claude', sessionId, cwd: FIXTURE_CWD, configDir, mode: 'settlement',
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation &&
        error.message.includes('changed during durability confirmation'),
    );
    assert.equal(fault.wasTriggered(), true);
  } finally {
    fault.restore();
  }
});

test('appendClaudeCodeSessionHistory rejects a foreign in-record session before mutation', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-cfg-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const foreign = await readFile(GOLDEN);
  await writeFile(logPath, foreign);

  await assert.rejects(
    () => appendClaudeCodeSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, configDir }),
    (error) => error instanceof OpenPError && error.exitCode === 40,
  );
  assert.deepEqual(await readFile(logPath), foreign);
});

// Revised reader contract: a trailing caller user without a completion boundary is an interrupted
// turn and is dropped on read, so seeding past it is now accepted (the pre-drop writer rejected this
// target with exit 40 through the candidate read). The interrupted record must stay dropped — it is
// never promoted to a completed turn by the appended suffix.
test('appendClaudeCodeSessionHistory seeds past an interrupted trailing user without emitting it', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-cfg-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const base = logForSession(await readFile(GOLDEN, 'utf8'), sessionId, FIXTURE_CWD);
  const interrupted = {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: lastUuid(fixtureEntries(base)),
    message: { role: 'user', content: 'INTERRUPTED-TARGET-PROMPT' },
    cwd: FIXTURE_CWD,
    sessionId,
  };
  const original = Buffer.from(`${base.trimEnd()}\n${JSON.stringify(interrupted)}\n`);
  await writeFile(logPath, original);
  assert.equal(extractClaudeNativeTurns(original.toString('utf8')).length, 2);

  const result = await appendClaudeCodeSessionHistory({
    sessionId,
    cwd: FIXTURE_CWD,
    turns: TURNS.slice(0, 1),
    persistPreparedAppend,
    configDir,
  });
  assert.equal(result.turns.length, 1);

  const after = await readFile(logPath);
  assert.equal(
    createHash('sha256').update(after.subarray(0, original.length)).digest('hex'),
    createHash('sha256').update(original).digest('hex'),
    'target prefix bytes must be immutable',
  );
  const originalLines = original.toString('utf8').trimEnd().split('\n');
  const afterLines = after.toString('utf8').trimEnd().split('\n');
  assert.equal(afterLines.length, originalLines.length + 3);
  const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);
  assert.equal(appended[0]!.parentUuid, interrupted.uuid, 'the chain continues after the interrupted record');

  const readBack = extractClaudeNativeTurns(after.toString('utf8'));
  assert.equal(readBack.length, 3);
  assert.equal(readBack.at(-1)!.userText, TURNS[0]!.userText);
  assert.equal(readBack.at(-1)!.assistantText, TURNS[0]!.assistantText);
  assert.deepEqual(readBack.at(-1)!.nativeIds, result.turns[0]!.nativeIds);
  assert.ok(
    !JSON.stringify(readBack).includes('INTERRUPTED-TARGET-PROMPT'),
    'the interrupted turn must stay dropped after seeding, never promoted to a completed turn',
  );
});

test('appendClaudeCodeSessionHistory rejects a branch-changing sidechain target suffix before mutation', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-cfg-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const base = logForSession(await readFile(GOLDEN, 'utf8'), sessionId, FIXTURE_CWD);
  const baseTurns = extractClaudeNativeTurns(base);
  const extra = {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: baseTurns[0]!.nativeIds.completionId,
    isSidechain: true,
    message: { role: 'user', content: 'unfinished target state' },
    cwd: FIXTURE_CWD,
    sessionId,
  };
  const original = Buffer.from(`${base.trimEnd()}\n${JSON.stringify(extra)}\n`);
  await writeFile(logPath, original);

  await assert.rejects(
    () => appendClaudeCodeSessionHistory({
      sessionId,
      cwd: FIXTURE_CWD,
      turns: TURNS.slice(0, 1),
      persistPreparedAppend,
      configDir,
    }),
    (error) => error instanceof OpenPError && error.exitCode === 40,
  );
  assert.deepEqual(await readFile(logPath), original);
});

// Before segment support, any compacted target was rejected with exit 40 at read time; this locks
// that a compacted session is now an intended, safe seed append target.
test('appendClaudeCodeSessionHistory seeds a compacted target and never clones the compaction summary', async () => {
  const goldenText = await readFile(GOLDEN, 'utf8');
  for (const variant of ['completed-turn-tail', 'summary-tail'] as const) {
    const sessionId = randomUUID();
    const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-compacted-'));
    const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
    await mkdir(dirname(logPath), { recursive: true });
    const base = logForSession(goldenText, sessionId, FIXTURE_CWD);
    const stamp = { cwd: FIXTURE_CWD, sessionId };
    const compactionRecords: Entry[] = [
      { type: 'system', subtype: 'compact_boundary', uuid: 'compact-1-boundary', parentUuid: null, ...stamp },
      {
        type: 'user', isCompactSummary: true, uuid: 'compact-1-summary', parentUuid: 'compact-1-boundary',
        message: { role: 'user', content: 'COMPACT-SUMMARY: condensed history' }, ...stamp,
      },
      ...(variant === 'completed-turn-tail' ? [
        {
          type: 'user', uuid: 'post-compact-user', parentUuid: 'compact-1-summary',
          message: { role: 'user', content: 'post-compact prompt' }, ...stamp,
        },
        {
          type: 'assistant', uuid: 'post-compact-assistant', parentUuid: 'post-compact-user',
          message: {
            id: 'post-compact-message', role: 'assistant',
            content: [{ type: 'text', text: 'POST-COMPACT-ANSWER' }],
          },
          ...stamp,
        },
        {
          type: 'system', subtype: 'turn_duration', uuid: 'post-compact-completion',
          parentUuid: 'post-compact-assistant', durationMs: 1, ...stamp,
        },
      ] : []),
    ];
    const original = Buffer.from(`${base.trimEnd()}\n${compactionRecords.map((e) => JSON.stringify(e)).join('\n')}\n`);
    await writeFile(logPath, original);
    const beforeTurns = extractClaudeNativeTurns(original.toString('utf8'));
    assert.equal(beforeTurns.length, variant === 'completed-turn-tail' ? 3 : 2);

    const result = await appendClaudeCodeSessionHistory({
      sessionId, cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, configDir,
    });
    assert.equal(result.turns.length, TURNS.length);

    const after = await readFile(logPath);
    assert.equal(
      createHash('sha256').update(after.subarray(0, original.length)).digest('hex'),
      createHash('sha256').update(original).digest('hex'),
      'compacted target prefix bytes must be immutable',
    );
    const originalLines = original.toString('utf8').trimEnd().split('\n');
    const afterLines = after.toString('utf8').trimEnd().split('\n');
    assert.equal(afterLines.length, originalLines.length + TURNS.length * 3);
    const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);

    // The parent chain starts at the compacted log's last uuid-bearing entry (final segment).
    assert.equal(
      appended[0]!.parentUuid,
      variant === 'completed-turn-tail' ? 'post-compact-completion' : 'compact-1-summary',
    );
    // The isCompactSummary user is never a clone template: no appended entry carries the summary
    // flag or the summary text. In the summary-tail variant the summary is the last user-type entry,
    // so this is only satisfiable by cloning the pre-boundary caller template.
    for (const entry of appended) {
      assert.notEqual(entry.isCompactSummary, true);
      assert.ok(!JSON.stringify(entry).includes('COMPACT-SUMMARY'), 'summary content must never be cloned');
    }
    assert.deepEqual(textEntries(appended).map(extractedText), EXPECTED_TEXT_ENTRIES.map((t) => t.text));
    assert.equal(completionEntries(appended).length, TURNS.length);

    // Round-trip: the production read recovers the pre-existing turns plus exactly the seeded turns.
    const readBack = await readClaudeCodeNativeSession({
      backend: 'claude', sessionId, cwd: FIXTURE_CWD, configDir,
    });
    assert.equal(readBack.turns.length, beforeTurns.length + TURNS.length);
    assert.deepEqual(
      readBack.turns.slice(beforeTurns.length).map((turn) => [turn.userText, turn.assistantText]),
      TURNS.map((turn) => [turn.userText, turn.assistantText]),
    );
    assert.deepEqual(
      readBack.turns.slice(beforeTurns.length).map((turn) => turn.nativeIds),
      result.turns.map((turn) => turn.nativeIds),
    );
    assert.ok(!JSON.stringify(readBack.turns).includes('COMPACT-SUMMARY'));
  }
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

test('provider-error assistant entries are never selected as Claude seed writer templates', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const parent = lastUuid(fixtureEntries(logText));
  const variants: readonly [string, Readonly<Record<string, unknown>>][] = [
    ['flag', { isApiErrorMessage: true }],
    ['status', { apiErrorStatus: 429 }],
    ['error', { error: 'rate_limit' }],
  ];
  for (const [name, marker] of variants) {
    const poisoned = [
      logText.trimEnd(),
      JSON.stringify({
        type: 'assistant',
        uuid: `provider-error-template-${name}`,
        parentUuid: parent,
        ...marker,
        message: {
          id: `provider-error-template-message-${name}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'provider error notice' }],
        },
      }),
    ].join('\n');

    const built = buildClaudeCodeHistoryEntries(poisoned, TURNS.slice(0, 1), NOW);
    const appended = built.lines.map((line) => JSON.parse(line) as Entry);
    const assistant = appended[1]!;
    assert.equal(assistant.type, 'assistant');
    assert.equal(assistant.isApiErrorMessage, undefined);
    assert.equal(assistant.apiErrorStatus, undefined);
    assert.equal(assistant.error, undefined);

    const readBack = extractClaudeNativeTurns(`${poisoned}\n${built.lines.join('\n')}\n`);
    const suffix = readBack.at(-1)!;
    assert.equal(suffix.userText, TURNS[0]!.userText);
    assert.equal(suffix.assistantText, TURNS[0]!.assistantText);
    assert.deepEqual(suffix.nativeIds, built.written[0]!.nativeIds);
  }
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
    () => appendClaudeCodeSessionHistory({ sessionId: randomUUID(), cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, configDir }),
    (error) => error instanceof OpenPError && error.exitCode === 41,
  );
});

test('appendClaudeCodeSessionHistory rejects an aborted signal before the write and leaves the log untouched', async () => {
  const sessionId = randomUUID();
  const configDir = await mkdtemp(join(tmpdir(), 'openp-claude-cfg-'));
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, FIXTURE_CWD, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const original = Buffer.from(logForSession(await readFile(GOLDEN, 'utf8'), sessionId, FIXTURE_CWD));
  await writeFile(logPath, original);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => appendClaudeCodeSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, configDir, signal: controller.signal }),
    isAbortError,
  );
  assert.equal(
    createHash('sha256').update(await readFile(logPath)).digest('hex'),
    createHash('sha256').update(original).digest('hex'),
    'log must be byte-identical after an aborted append',
  );
});
