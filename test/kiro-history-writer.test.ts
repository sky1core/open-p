import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { SeedWriteTurn } from '../src/core/backend.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import {
  appendKiroSessionHistory,
  buildKiroCompanionWithAppendedTurns,
  buildKiroHistoryEntries,
  cleanupKiroPreparedSessionHistoryAppend,
  commitKiroHistoryAppend,
} from '../src/backends/kiro/history-writer.js';
import { kiroNativeStateDigest, readKiroNativeSession } from '../src/backends/kiro/native-reader.js';
import { resolveKiroSessionLogPath } from '../src/backends/kiro/session-log.js';
import { installFileDriftOnNextSync } from './helpers/native-file-sync-fault.js';

const GOLDEN = join(process.cwd(), 'test/fixtures/seed/redacted-kiro-golden.jsonl');
const COMPANION = join(process.cwd(), 'test/fixtures/seed/redacted-kiro-golden.json');
const FIXTURE_CWD = '/redacted/workspace';
const NOW_SEC = Math.floor(Date.UTC(2026, 6, 14, 12, 0, 0) / 1000);
const persistPreparedAppend = async (): Promise<void> => undefined;
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

function companionForSession(companionText: string, sessionId: string, logText?: string): string {
  const companion = JSON.parse(companionText);
  companion.session_id = sessionId;
  companion.session_state.rts_model_state.conversation_id = sessionId;
  if (logText !== undefined) {
    const logIds = new Set(fixtureEntries(logText).map((entry) => entry.data?.message_id).filter(Boolean));
    companion.session_state.conversation_metadata.user_turn_metadatas =
      companion.session_state.conversation_metadata.user_turn_metadatas.filter((metadata: Entry) =>
        Array.isArray(metadata.message_ids) && metadata.message_ids.every((id: string) => logIds.has(id)),
      );
  }
  return `${JSON.stringify(companion, null, 2)}\n`;
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

test('buildKiroHistoryEntries deletes inherited AssistantMessage meta from cloned templates', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const assistantTemplate = [...fixtureEntries(logText)].reverse()
    .find((entry) => entry.kind === 'AssistantMessage')!;
  const poisonedAssistant = structuredClone(assistantTemplate);
  poisonedAssistant.data.meta = { timestamp: 123, stale: true };
  const built = buildKiroHistoryEntries(`${logText.trimEnd()}\n${JSON.stringify(poisonedAssistant)}\n`, TURNS.slice(0, 1), NOW_SEC);
  const appendedAssistant = JSON.parse(built.lines[1]!) as Entry;

  assert.equal(appendedAssistant.kind, 'AssistantMessage');
  assert.equal(Object.prototype.hasOwnProperty.call(appendedAssistant.data, 'meta'), false);
});

test('buildKiroHistoryEntries never moves Prompt timestamps behind the existing native history', async () => {
  const logText = await readFile(GOLDEN, 'utf8');
  const promptTemplate = [...fixtureEntries(logText)].reverse().find((entry) => entry.kind === 'Prompt')!;
  const futurePrompt = structuredClone(promptTemplate);
  futurePrompt.data.message_id = randomUUID();
  futurePrompt.data.meta.timestamp = NOW_SEC + 10_000;
  const built = buildKiroHistoryEntries(
    `${logText.trimEnd()}\n${JSON.stringify(futurePrompt)}\n`,
    TURNS.slice(0, 1),
    NOW_SEC,
  );
  const appendedPrompt = JSON.parse(built.lines[0]!) as Entry;

  assert.equal(appendedPrompt.data.meta.timestamp, futurePrompt.data.meta.timestamp);
});

test('appendKiroSessionHistory appends to the jsonl and updates the .json companion completions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    await mkdir(dirname(logPath), { recursive: true });
    const original = await readFile(GOLDEN);
    const companionOriginal = Buffer.from(companionForSession(
      await readFile(COMPANION, 'utf8'),
      sessionId,
      original.toString('utf8'),
    ));
    await writeFile(logPath, original);
    await writeFile(companionPath, companionOriginal);
    await chmod(companionPath, 0o644);
    const beforeSha = sha256(original);
    const beforeCompanion = JSON.parse(companionOriginal.toString('utf8'));
    const beforeMetadataCount = beforeCompanion.session_state.conversation_metadata.user_turn_metadatas.length;
    let preparationCalls = 0;
    let preparedCandidateDigest: string | null = null;
    let cleanupToken = '';

    const result = await appendKiroSessionHistory({
      sessionId,
      cwd: FIXTURE_CWD,
      turns: TURNS,
      persistPreparedAppend: async (prepared) => {
        preparationCalls += 1;
        preparedCandidateDigest = prepared.candidateNativeStateDigest;
        cleanupToken = prepared.cleanupToken ?? '';
        assert.match(cleanupToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(prepared.turns.length, TURNS.length);
        await assert.rejects(
          () => stat(join(dirname(logPath), `.openp-seed-${cleanupToken}`)),
          (error: any) => error?.code === 'ENOENT',
          'the prepared barrier must run before the transcript temp directory exists',
        );
        assert.deepEqual(await readFile(logPath), original, 'durability barrier must precede JSONL mutation');
        assert.deepEqual(
          await readFile(companionPath),
          companionOriginal,
          'durability barrier must precede companion mutation',
        );
      },
    });

    const after = await readFile(logPath);
    const afterCompanionBytes = await readFile(companionPath);
    assert.equal((await stat(companionPath)).mode & 0o777, 0o644);
    const tempDir = join(dirname(logPath), `.openp-seed-${cleanupToken}`);
    await assert.rejects(
      () => stat(tempDir),
      (error: any) => error?.code === 'ENOENT',
      'the Writer should immediately clean the locator after a caught successful commit',
    );
    assert.equal(preparationCalls, 1);
    assert.equal(kiroNativeStateDigest(after, afterCompanionBytes), preparedCandidateDigest);
    assert.equal(sha256(after.subarray(0, original.length)), beforeSha, 'existing jsonl bytes must be immutable');
    const originalLines = original.toString('utf8').trimEnd().split('\n');
    const afterLines = after.toString('utf8').trimEnd().split('\n');
    assert.equal(afterLines.length, originalLines.length + EXPECTED_ENTRIES.length);
    const appended = afterLines.slice(originalLines.length).map((l) => JSON.parse(l) as Entry);
    assert.deepEqual(appended.map(kiroText), EXPECTED_ENTRIES.map((t) => t.text));
    assert.equal(result.turns.length, TURNS.length);
    const afterCompanion = JSON.parse(afterCompanionBytes.toString('utf8'));
    const metadatas = afterCompanion.session_state.conversation_metadata.user_turn_metadatas;
    assert.equal(metadatas.length, beforeMetadataCount + TURNS.length);
    const appendedMetadata = metadatas.slice(beforeMetadataCount);
    assert.deepEqual(appendedMetadata.map((m: any) => m.message_ids), result.turns.map((turn) => [
      turn.nativeIds.userId,
      ...turn.nativeIds.assistantIds,
    ]));
    assert.deepEqual(appendedMetadata.map((m: any) => m.result.Ok.content[0].data), TURNS.map((turn) => turn.assistantText));
    await cleanupKiroPreparedSessionHistoryAppend({
      sessionId,
      cwd: FIXTURE_CWD,
      token: cleanupToken,
    });
    await cleanupKiroPreparedSessionHistoryAppend({
      sessionId,
      cwd: FIXTURE_CWD,
      token: cleanupToken,
    });
  });
});

test('Kiro production reader confirms a stable two-file settlement snapshot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-settlement-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    await mkdir(dirname(logPath), { recursive: true });
    const logBytes = await readFile(GOLDEN);
    const companionBytes = Buffer.from(companionForSession(
      await readFile(COMPANION, 'utf8'),
      sessionId,
      logBytes.toString('utf8'),
    ));
    await writeFile(logPath, logBytes);
    await writeFile(companionPath, companionBytes);

    const read = await readKiroNativeSession({ backend: 'kiro', sessionId, mode: 'settlement' });

    assert.equal(read.nativeStateDigest, kiroNativeStateDigest(logBytes, companionBytes));
    assert.equal(read.turns.length > 0, true);
  });
});

test('Kiro production reader rejects first-read drift only in settlement mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-settlement-drift-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    await mkdir(dirname(logPath), { recursive: true });
    const logBytes = await readFile(GOLDEN);
    const companionBytes = Buffer.from(companionForSession(
      await readFile(COMPANION, 'utf8'), sessionId, logBytes.toString('utf8'),
    ));
    await writeFile(logPath, logBytes);
    await writeFile(companionPath, companionBytes);
    const fault = await installFileDriftOnNextSync(logPath, Buffer.concat([logBytes, Buffer.from('\n')]));
    try {
      await assert.doesNotReject(() => readKiroNativeSession({
        backend: 'kiro', sessionId, mode: 'logical',
      }));
      assert.equal(fault.wasTriggered(), false);
      await assert.rejects(
        () => readKiroNativeSession({ backend: 'kiro', sessionId, mode: 'settlement' }),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation &&
          error.message.includes('changed during durability confirmation'),
      );
      assert.equal(fault.wasTriggered(), true);
    } finally {
      fault.restore();
    }
  });
});

test('appendKiroSessionHistory rejects a companion owned by another session before mutation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    await mkdir(dirname(logPath), { recursive: true });
    const original = await readFile(GOLDEN);
    const foreignCompanion = await readFile(COMPANION);
    await writeFile(logPath, original);
    await writeFile(companionPath, foreignCompanion);

    await assert.rejects(
      () => appendKiroSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.deepEqual(await readFile(logPath), original);
    assert.deepEqual(await readFile(companionPath), foreignCompanion);
  });
});

test('appendKiroSessionHistory rejects trailing incomplete companion metadata before mutation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    await mkdir(dirname(logPath), { recursive: true });
    const baseLog = await readFile(GOLDEN, 'utf8');
    const pendingId = randomUUID();
    const pendingPrompt = {
      version: 'v1',
      kind: 'Prompt',
      data: {
        message_id: pendingId,
        content: [{ kind: 'text', data: 'unfinished target state' }],
        meta: { timestamp: NOW_SEC + 20_000 },
      },
    };
    const originalLog = Buffer.from(`${baseLog.trimEnd()}\n${JSON.stringify(pendingPrompt)}\n`);
    const companion = JSON.parse(companionForSession(
      await readFile(COMPANION, 'utf8'),
      sessionId,
      baseLog,
    ));
    companion.session_state.conversation_metadata.user_turn_metadatas.push({
      message_ids: [pendingId],
      end_reason: 'InProgress',
    });
    const originalCompanion = Buffer.from(`${JSON.stringify(companion, null, 2)}\n`);
    await writeFile(logPath, originalLog);
    await writeFile(companionPath, originalCompanion);

    await assert.rejects(
      () => appendKiroSessionHistory({
        sessionId,
        cwd: FIXTURE_CWD,
        turns: TURNS.slice(0, 1),
        persistPreparedAppend,
      }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.deepEqual(await readFile(logPath), originalLog);
    assert.deepEqual(await readFile(companionPath), originalCompanion);
  });
});

test('companion publish failure rolls the JSONL append back to its exact prior bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-transaction-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const cleanupToken = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    const original = Buffer.from('{"existing":true}\n');
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, original);
    await mkdir(companionPath);

    await assert.rejects(() => commitKiroHistoryAppend({
      logPath,
      companionPath,
      lines: ['{"new":true}'],
      companion: '{"updated":true}\n',
      cleanupToken,
    }));
    assert.deepEqual(await readFile(logPath), original);
    const tempDir = join(dirname(logPath), `.openp-seed-${cleanupToken}`);
    assert.deepEqual(await readdir(tempDir), ['companion.tmp']);
    await cleanupKiroPreparedSessionHistoryAppend({
      sessionId,
      cwd: FIXTURE_CWD,
      token: cleanupToken,
    });
    await assert.rejects(() => stat(tempDir), (error: any) => error?.code === 'ENOENT');
  });
});

test('Kiro prepared cleanup rejects non-UUID locators without touching the session root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-cleanup-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    await mkdir(dirname(logPath), { recursive: true });
    const sentinel = join(dirname(logPath), 'sentinel');
    await writeFile(sentinel, 'keep');
    await assert.rejects(
      () => cleanupKiroPreparedSessionHistoryAppend({
        sessionId,
        cwd: FIXTURE_CWD,
        token: '../../sentinel',
      }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  });
});

test('Kiro cleanup recovers a crash-created private locator before chmod completed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-cleanup-mode-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const cleanupToken = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    const tempDir = join(dirname(logPath), `.openp-seed-${cleanupToken}`);
    const tempFile = join(tempDir, 'companion.tmp');
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    await writeFile(companionPath, '{}\n', { mode: 0o644 });
    await chmod(companionPath, 0o644);
    await writeFile(tempFile, 'partial private companion', { mode: 0o600 });
    await chmod(tempFile, 0o000);
    await chmod(tempDir, 0o000);

    await cleanupKiroPreparedSessionHistoryAppend({
      sessionId,
      cwd: FIXTURE_CWD,
      token: cleanupToken,
    });

    await assert.rejects(() => stat(tempDir), (error: any) => error?.code === 'ENOENT');
  });
});

test('Kiro cleanup validates a retained temp file mode and symlink before unlinking it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-cleanup-file-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;
    const companionPath = logPath.replace(/\.jsonl$/, '.json');
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(companionPath, '{}\n', { mode: 0o644 });
    await chmod(companionPath, 0o644);

    const wrongModeToken = randomUUID();
    const wrongModeDir = join(dirname(logPath), `.openp-seed-${wrongModeToken}`);
    const wrongModeFile = join(wrongModeDir, 'companion.tmp');
    await mkdir(wrongModeDir, { mode: 0o700 });
    await writeFile(wrongModeFile, 'retained companion', { mode: 0o600 });
    await chmod(wrongModeFile, 0o666);
    await assert.rejects(
      () => cleanupKiroPreparedSessionHistoryAppend({
        sessionId,
        cwd: FIXTURE_CWD,
        token: wrongModeToken,
      }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.equal(await readFile(wrongModeFile, 'utf8'), 'retained companion');
    await chmod(wrongModeFile, 0o644);
    await cleanupKiroPreparedSessionHistoryAppend({
      sessionId,
      cwd: FIXTURE_CWD,
      token: wrongModeToken,
    });

    const symlinkToken = randomUUID();
    const symlinkDir = join(dirname(logPath), `.openp-seed-${symlinkToken}`);
    const symlinkFile = join(symlinkDir, 'companion.tmp');
    const external = join(home, 'external-sentinel');
    await writeFile(external, 'keep');
    await mkdir(symlinkDir, { mode: 0o700 });
    await symlink(external, symlinkFile);
    await assert.rejects(
      () => cleanupKiroPreparedSessionHistoryAppend({
        sessionId,
        cwd: FIXTURE_CWD,
        token: symlinkToken,
      }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
    );
    assert.equal(await readFile(external, 'utf8'), 'keep');
    await unlink(symlinkFile);
    await cleanupKiroPreparedSessionHistoryAppend({
      sessionId,
      cwd: FIXTURE_CWD,
      token: symlinkToken,
    });
    assert.equal(await readFile(external, 'utf8'), 'keep');
  });
});

test('Kiro cleanup retries an absent locator until its parent-directory sync can succeed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-cleanup-retry-home-'));
  await withHome(home, async () => {
    const sessionId = randomUUID();
    const cleanupToken = randomUUID();
    const logPath = resolveKiroSessionLogPath(sessionId, { HOME: home })!;

    await assert.rejects(
      () => cleanupKiroPreparedSessionHistoryAppend({
        sessionId,
        cwd: FIXTURE_CWD,
        token: cleanupToken,
      }),
      (error) => error instanceof OpenPError && error.exitCode === 40,
      'locator absence is not settled while its parent cannot be synced',
    );

    await mkdir(dirname(logPath), { recursive: true });
    await cleanupKiroPreparedSessionHistoryAppend({
      sessionId,
      cwd: FIXTURE_CWD,
      token: cleanupToken,
    });
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
    () => appendKiroSessionHistory({ sessionId: 'unsafe/../id', cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend }),
    (error) => error instanceof OpenPError && error.exitCode === 41,
  );
});

test('appendKiroSessionHistory reports a missing log as sessionLogNotFound', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  await withHome(home, async () => {
    await assert.rejects(
      () => appendKiroSessionHistory({ sessionId: randomUUID(), cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend }),
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
      () => appendKiroSessionHistory({ sessionId, cwd: FIXTURE_CWD, turns: TURNS, persistPreparedAppend, signal: controller.signal }),
      isAbortError,
    );
    assert.equal(sha256(await readFile(logPath)), sha256(original), 'log must be byte-identical after an aborted append');
  });
});
