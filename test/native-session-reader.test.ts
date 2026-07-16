import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  assertClaudeNativeSessionIdentity,
  claudeNativeStateDigest,
  extractClaudeNativeTurns,
} from '../src/backends/claude/native-reader.js';
import {
  assertCodexNativeSessionIdentity,
  codexNativeStateDigest,
  extractCodexNativeTurns,
} from '../src/backends/codex/native-reader.js';
import { extractKiroNativeTurns, kiroNativeStateDigest } from '../src/backends/kiro/native-reader.js';
import {
  assertOpenCodeExportOk,
  assertStableOpenCodeNativeExports,
  extractOpenCodeNativeTurns,
  openCodeNativeStateDigest,
} from '../src/backends/opencode/native-reader.js';
import { isAbortError } from '../src/core/abort.js';
import { OpenPError } from '../src/core/errors.js';
import { decodeNativeStateUtf8, digestNativeState } from '../src/core/native-state-digest.js';

const FIXTURES = join(process.cwd(), 'test/fixtures/seed');

function rejects(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OpenPError, `expected OpenPError, got ${String(error)}`);
    assert.equal(error.exitCode, 40);
    return;
  }
  throw new Error('expected native reader to fail closed');
}

function lines(text: string): string[] {
  return text.trimEnd().split('\n').filter(Boolean);
}

function lastUuid(logText: string): string {
  const entry = lines(logText).map((line) => JSON.parse(line)).reverse().find((item) =>
    typeof item.uuid === 'string' && item.uuid.length > 0,
  );
  assert.ok(entry);
  return entry.uuid;
}

async function rejectClaudeCyclesWithoutHanging(logTexts: readonly string[]): Promise<void> {
  const moduleUrl = new URL('../src/backends/claude/native-reader.ts', import.meta.url).href;
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { extractClaudeNativeTurns } from ${JSON.stringify(moduleUrl)};
      const results = workerData.map((logText) => {
        try {
          extractClaudeNativeTurns(logText);
          return { ok: true };
        } catch (error) {
          return { ok: false, exitCode: error?.exitCode ?? null, message: error?.message ?? String(error) };
        }
      });
      parentPort.postMessage(results);
    `, {
      eval: true,
      workerData: [...logTexts],
      execArgv: ['--import', 'tsx'],
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error('Claude native reader cycle check timed out'));
    }, 10_000);
    worker.on('message', (message: unknown) => {
      const results = Array.isArray(message) ? message : [];
      const valid = results.length === logTexts.length && results.every((result) =>
        typeof result === 'object' && result !== null &&
        (result as { readonly ok?: unknown }).ok === false &&
        (result as { readonly exitCode?: unknown }).exitCode === 40,
      );
      finish(valid ? undefined : new Error(`expected Claude cycle protocol failures, got ${JSON.stringify(message)}`));
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => {
      if (!settled) finish(new Error(`Claude native reader worker exited before reporting (code ${code})`));
    });
  });
}

function validKiroCompanion(logText: string, companionText: string): string {
  const logIds = new Set(lines(logText).map((line) => JSON.parse(line).data?.message_id).filter(Boolean));
  const companion = JSON.parse(companionText);
  companion.session_state.conversation_metadata.user_turn_metadatas =
    companion.session_state.conversation_metadata.user_turn_metadatas.filter((metadata: any) =>
      Array.isArray(metadata.message_ids) && metadata.message_ids.every((id: string) => logIds.has(id)),
    );
  return JSON.stringify(companion);
}

test('Claude reader extracts completed caller/final assistant pairs and drops trailing incomplete users', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const trailingUser = JSON.stringify({
    type: 'user',
    uuid: 'trailing-user',
    parentUuid: lastUuid(logText),
    message: { role: 'user', content: 'unfinished' },
  });
  const baseText = logText.endsWith('\n') ? logText : `${logText}\n`;
  const withTrailingUser = `${baseText}${trailingUser}\n`;
  const turns = extractClaudeNativeTurns(withTrailingUser);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.assistantText, 'REMEMBERED');
  assert.equal(turns[1]!.assistantText, 'BLUEFIN-7');
  assert.ok(turns.every((turn) => turn.nativeIds.userId.length > 0 && turn.nativeIds.assistantIds.length === 1));
  assert.notEqual(
    claudeNativeStateDigest(Buffer.from(withTrailingUser)),
    claudeNativeStateDigest(Buffer.from(baseText)),
  );

  const withoutLastCompletion = lines(logText)
    .map((line) => JSON.parse(line))
    .filter((entry) => !(entry.type === 'system' && entry.subtype === 'turn_duration' &&
      entry.uuid === turns[1]!.nativeIds.completionId))
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  assert.equal(extractClaudeNativeTurns(`${withoutLastCompletion}\n`).length, 1);
  assert.notEqual(
    claudeNativeStateDigest(Buffer.from(`${withoutLastCompletion}\n`)),
    claudeNativeStateDigest(Buffer.from(baseText)),
  );
});

test('Claude reader binds in-record identity to the requested session and workspace', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const entries = lines(logText).map((line) => JSON.parse(line));
  const expectedSessionId = entries.find((entry) => typeof entry.sessionId === 'string')!.sessionId as string;
  const expectedCwd = entries.find((entry) => typeof entry.cwd === 'string')!.cwd as string;
  await assert.doesNotReject(() => assertClaudeNativeSessionIdentity(logText, expectedSessionId, expectedCwd));

  const wrongSession = entries.map((entry) => entry.sessionId === expectedSessionId
    ? { ...entry, sessionId: 'foreign-session' }
    : entry).map((entry) => JSON.stringify(entry)).join('\n');
  await assert.rejects(() => assertClaudeNativeSessionIdentity(wrongSession, expectedSessionId, expectedCwd));

  const wrongWorkspace = entries.map((entry) => typeof entry.cwd === 'string'
    ? { ...entry, cwd: '/foreign/workspace' }
    : entry).map((entry) => JSON.stringify(entry)).join('\n');
  await assert.rejects(() => assertClaudeNativeSessionIdentity(wrongWorkspace, expectedSessionId, expectedCwd));

  const mixedWorkspace = structuredClone(entries);
  mixedWorkspace.find((entry) => typeof entry.cwd === 'string')!.cwd = '/foreign/workspace';
  await assert.rejects(() => assertClaudeNativeSessionIdentity(
    mixedWorkspace.map((entry) => JSON.stringify(entry)).join('\n'),
    expectedSessionId,
    expectedCwd,
  ));
});

test('Claude reader rejects portable boundary records without a native uuid', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const parentUuid = lastUuid(logText);
  const missingUuidRecords = [
    { type: 'user', parentUuid, message: { role: 'user', content: 'unfinished' } },
    {
      type: 'assistant', parentUuid,
      message: { id: 'assistant-without-entry-uuid', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    },
    { type: 'system', subtype: 'turn_duration', parentUuid },
  ];
  for (const record of missingUuidRecords) {
    rejects(() => extractClaudeNativeTurns(`${logText.trimEnd()}\n${JSON.stringify(record)}\n`));
  }
});

test('Claude reader rejects a completion uuid reused as an assistant message id', () => {
  const records = [
    { type: 'system', subtype: 'init', uuid: 'root-status' },
    {
      type: 'user', uuid: 'user-entry', parentUuid: 'root-status',
      message: { role: 'user', content: 'hello' },
    },
    {
      type: 'assistant', uuid: 'assistant-entry', parentUuid: 'user-entry',
      message: {
        id: 'shared-completion-id',
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
      },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'shared-completion-id',
      parentUuid: 'assistant-entry', durationMs: 1,
    },
  ];

  rejects(() => extractClaudeNativeTurns(records.map((entry) => JSON.stringify(entry)).join('\n')));
});

test('Claude reader rejects a text-bearing assistant record without message.id', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const parent = lastUuid(logText);
  const missingMessageId = [
    {
      type: 'user', uuid: 'missing-message-id-user', parentUuid: parent,
      message: { role: 'user', content: 'prompt' },
    },
    {
      type: 'assistant', uuid: 'missing-message-id-assistant', parentUuid: 'missing-message-id-user',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'missing-message-id-completion',
      parentUuid: 'missing-message-id-assistant', durationMs: 1,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  rejects(() => extractClaudeNativeTurns(`${logText}\n${missingMessageId}\n`));
});

test('Claude reader rejects compaction summaries and compact boundaries', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  rejects(() => extractClaudeNativeTurns(`${logText}\n${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c' })}\n`));
  rejects(() => extractClaudeNativeTurns(`${logText}\n${JSON.stringify({ type: 'user', isCompactSummary: true, uuid: 'c', message: { content: 'summary' } })}\n`));
});

test('Claude reader excludes prompt-id-linked local command transcript records', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const parent = lastUuid(logText);
  const localCommand = [
    {
      type: 'user', isMeta: true, uuid: 'local-caveat', parentUuid: parent, promptId: 'local-command-group',
      message: { role: 'user', content: '<local-command-caveat>local command</local-command-caveat>' },
    },
    {
      type: 'user', uuid: 'local-command-name', parentUuid: 'local-caveat', promptId: 'local-command-group',
      message: { role: 'user', content: '<command-name>/exit</command-name>' },
    },
    {
      type: 'user', uuid: 'local-command-output', parentUuid: 'local-command-name', promptId: 'local-command-group',
      message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' },
    },
    {
      type: 'user', uuid: 'caller-after-local', parentUuid: 'local-command-output', promptId: 'caller-prompt',
      message: { role: 'user', content: 'real caller after local command' },
    },
    {
      type: 'assistant', uuid: 'assistant-after-local', parentUuid: 'caller-after-local',
      message: { id: 'message-after-local', role: 'assistant', content: [{ type: 'text', text: 'real answer' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'completion-after-local',
      parentUuid: 'assistant-after-local', durationMs: 10,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${localCommand}\n`);
  assert.equal(turns.length, 3);
  assert.equal(turns[2]!.userText, 'real caller after local command');
  assert.equal(turns.some((turn) => turn.userText.includes('<command-name>') ||
    turn.userText.includes('<local-command-stdout>')), false);
});

test('Claude reader excludes meta and sidechain assistants and completion boundaries', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const parent = lastUuid(logText);
  const scopedTurn = [
    {
      type: 'user', uuid: 'scoped-user', parentUuid: parent,
      message: { role: 'user', content: 'portable prompt' },
    },
    {
      type: 'assistant', isMeta: true, uuid: 'meta-assistant', parentUuid: 'scoped-user',
      message: { id: 'meta-message', role: 'assistant', content: [{ type: 'text', text: 'meta answer' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', isMeta: true, uuid: 'meta-completion',
      parentUuid: 'meta-assistant', durationMs: 1,
    },
    {
      type: 'assistant', uuid: 'portable-assistant', parentUuid: 'meta-completion',
      message: { id: 'portable-message', role: 'assistant', content: [{ type: 'text', text: 'portable answer' }] },
    },
    {
      type: 'assistant', isSidechain: true, uuid: 'sidechain-assistant', parentUuid: 'portable-assistant',
      message: { id: 'sidechain-message', role: 'assistant', content: [{ type: 'text', text: 'sidechain answer' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', isSidechain: true, uuid: 'sidechain-completion',
      parentUuid: 'sidechain-assistant', durationMs: 1,
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'portable-completion',
      parentUuid: 'sidechain-completion', durationMs: 1,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${scopedTurn}\n`);
  assert.equal(turns.length, 3);
  assert.equal(turns[2]!.userText, 'portable prompt');
  assert.equal(turns[2]!.assistantText, 'portable answer');
  assert.deepEqual(turns[2]!.nativeIds.assistantIds, ['portable-message']);
  assert.equal(turns[2]!.nativeIds.completionId, 'portable-completion');
});

test('Claude reader drops an entire provider-error interrupted turn', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const parent = lastUuid(logText);
  const interrupted = [
    {
      type: 'user', uuid: 'provider-error-user', parentUuid: parent,
      message: { role: 'user', content: 'will fail' },
    },
    {
      type: 'assistant', uuid: 'provider-error-partial', parentUuid: 'provider-error-user',
      message: { id: 'provider-error-partial-message', role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
    },
    {
      type: 'assistant', uuid: 'provider-error-notice', parentUuid: 'provider-error-partial',
      error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
      message: {
        id: 'provider-error-notice-message', model: '<synthetic>', role: 'assistant',
        content: [{ type: 'text', text: 'rate limit notice' }],
      },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'provider-error-completion',
      parentUuid: 'provider-error-notice', durationMs: 10,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${interrupted}\n`);
  assert.equal(turns.length, 2);
  assert.equal(turns.some((turn) => turn.assistantText.includes('partial answer') || turn.assistantText.includes('rate limit notice')), false);
});

test('Claude reader rejects a non-trailing turn without a completion boundary', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const parent = lastUuid(logText);
  const malformed = [
    {
      type: 'user', uuid: 'missing-completion-user', parentUuid: parent,
      message: { role: 'user', content: 'first' },
    },
    {
      type: 'assistant', uuid: 'missing-completion-assistant', parentUuid: 'missing-completion-user',
      message: { id: 'missing-completion-message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    },
    {
      type: 'user', uuid: 'following-user', parentUuid: 'missing-completion-assistant',
      message: { role: 'user', content: 'second' },
    },
    {
      type: 'assistant', uuid: 'following-assistant', parentUuid: 'following-user',
      message: { id: 'following-message', role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'following-completion',
      parentUuid: 'following-assistant', durationMs: 10,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  rejects(() => extractClaudeNativeTurns(`${logText}\n${malformed}\n`));
});

test('Claude reader rejects malformed parent lineage without truncating or looping', async () => {
  const root = {
    type: 'system',
    subtype: 'init',
    uuid: 'root-status',
  };
  const user = {
    type: 'user',
    uuid: 'user-1',
    parentUuid: 'root-status',
    message: { role: 'user', content: 'hello' },
  };
  const assistant = {
    type: 'assistant',
    uuid: 'assistant-1',
    parentUuid: 'user-1',
    message: { id: 'assistant-message-1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  };
  const completion = {
    type: 'system',
    subtype: 'turn_duration',
    uuid: 'completion-1',
    parentUuid: 'assistant-1',
  };
  const valid = [root, user, assistant, completion].map((entry) => JSON.stringify(entry)).join('\n');
  assert.equal(extractClaudeNativeTurns(`${valid}\n`).length, 1);

  rejects(() => extractClaudeNativeTurns([
    JSON.stringify(root),
    JSON.stringify(user),
    JSON.stringify({ ...assistant, parentUuid: 'missing-parent' }),
    JSON.stringify(completion),
  ].join('\n')));

  for (const parentUuid of [42, '']) {
    rejects(() => extractClaudeNativeTurns([
      JSON.stringify(root),
      JSON.stringify(user),
      JSON.stringify(assistant),
      JSON.stringify({ ...completion, parentUuid }),
    ].join('\n')));
  }
  for (const malformedCompletion of [
    { ...completion, parentUuid: null },
    (() => {
      const withoutParent = { ...completion } as Record<string, unknown>;
      delete withoutParent.parentUuid;
      return withoutParent;
    })(),
  ]) {
    rejects(() => extractClaudeNativeTurns([
      JSON.stringify(root),
      JSON.stringify(user),
      JSON.stringify(assistant),
      JSON.stringify(malformedCompletion),
    ].join('\n')));
  }

  rejects(() => extractClaudeNativeTurns([
    JSON.stringify(root),
    JSON.stringify(user),
    JSON.stringify(assistant),
    JSON.stringify(completion),
    JSON.stringify({ type: 'system', uuid: 'inactive-duplicate', parentUuid: 'completion-1', isSidechain: true }),
    JSON.stringify({ type: 'system', uuid: 'inactive-duplicate', parentUuid: 'completion-1', isSidechain: true }),
  ].join('\n')));

  await rejectClaudeCyclesWithoutHanging([
    [
      JSON.stringify(root),
      JSON.stringify({ ...user, parentUuid: 'user-1' }),
      JSON.stringify(assistant),
      JSON.stringify(completion),
    ].join('\n'),
    [
      JSON.stringify(root),
      JSON.stringify({ ...user, parentUuid: 'assistant-1' }),
      JSON.stringify({ ...assistant, parentUuid: 'user-1' }),
      JSON.stringify(completion),
    ].join('\n'),
  ]);

  rejects(() => extractClaudeNativeTurns([
    JSON.stringify(root),
    JSON.stringify(assistant),
    JSON.stringify(user),
    JSON.stringify(completion),
  ].join('\n')));
  rejects(() => extractClaudeNativeTurns([
    JSON.stringify(user),
    JSON.stringify(root),
    JSON.stringify(assistant),
    JSON.stringify(completion),
  ].join('\n')));

  const withInactiveMalformedSidechains = [
    root,
    user,
    assistant,
    completion,
    { type: 'system', uuid: 'inactive-dangling', parentUuid: 'missing-sidechain-parent', isSidechain: true },
    { type: 'system', uuid: 'inactive-cycle-a', parentUuid: 'inactive-cycle-b', isSidechain: true },
    { type: 'system', uuid: 'inactive-cycle-b', parentUuid: 'inactive-cycle-a', isSidechain: true },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  assert.equal(extractClaudeNativeTurns(withInactiveMalformedSidechains).length, 1);
});

test('Claude reader handles deep active lineages without recursive stack overflow', () => {
  const validEntries: object[] = [{ type: 'system', uuid: 'valid-deep-0' }];
  for (let index = 1; index <= 15_000; index += 1) {
    validEntries.push({ type: 'system', uuid: `valid-deep-${index}`, parentUuid: `valid-deep-${index - 1}` });
  }
  assert.deepEqual(extractClaudeNativeTurns(validEntries.map((entry) => JSON.stringify(entry)).join('\n')), []);

  const reverseEntries: object[] = [];
  for (let index = 15_000; index >= 0; index -= 1) {
    reverseEntries.push({
      type: 'system',
      uuid: `deep-${index}`,
      ...(index === 0 ? {} : { parentUuid: `deep-${index - 1}` }),
      isSidechain: true,
    });
  }
  reverseEntries.push({ type: 'system', uuid: 'active-tip', parentUuid: 'deep-15000' });
  rejects(() => extractClaudeNativeTurns(reverseEntries.map((entry) => JSON.stringify(entry)).join('\n')));
});

test('Codex reader extracts task-complete paired turns and ignores developer/reasoning mirrors', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  const trailingUser = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'unfinished' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'trailing-turn' },
    },
  });
  const baseText = logText.endsWith('\n') ? logText : `${logText}\n`;
  const withTrailingUser = `${baseText}${trailingUser}\n`;
  const turns = extractCodexNativeTurns(withTrailingUser);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.assistantText, 'REMEMBERED');
  assert.equal(turns[1]!.assistantText, 'BLUEFIN-7');
  assert.ok(turns.every((turn) => turn.nativeIds.completionId.length > 0));
  assert.notEqual(
    codexNativeStateDigest(Buffer.from(withTrailingUser)),
    codexNativeStateDigest(Buffer.from(baseText)),
  );

  const withoutLastCompletion = lines(logText)
    .map((line) => JSON.parse(line))
    .filter((entry) => !(entry.type === 'event_msg' && entry.payload?.type === 'task_complete' &&
      entry.payload.turn_id === turns[1]!.nativeIds.completionId))
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  assert.equal(extractCodexNativeTurns(`${withoutLastCompletion}\n`).length, 1);
  assert.notEqual(
    codexNativeStateDigest(Buffer.from(`${withoutLastCompletion}\n`)),
    codexNativeStateDigest(Buffer.from(baseText)),
  );
});

test('Codex reader binds session_meta identity to the requested native session', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  const entries = lines(logText).map((line) => JSON.parse(line));
  const sessionMeta = entries.find((entry) => entry.type === 'session_meta')!;
  const expectedSessionId = sessionMeta.payload.id as string;
  assert.doesNotThrow(() => assertCodexNativeSessionIdentity(logText, expectedSessionId));

  const wrongIdentity = structuredClone(entries);
  wrongIdentity.find((entry) => entry.type === 'session_meta')!.payload.session_id = 'foreign-session';
  rejects(() => assertCodexNativeSessionIdentity(
    wrongIdentity.map((entry) => JSON.stringify(entry)).join('\n'),
    expectedSessionId,
  ));

  const duplicateMetadata = `${logText.trimEnd()}\n${JSON.stringify(sessionMeta)}\n`;
  rejects(() => assertCodexNativeSessionIdentity(duplicateMetadata, expectedSessionId));
});

test('Codex reader rejects compaction, aborted turns, and rollback markers', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  rejects(() => extractCodexNativeTurns(`${logText}\n${JSON.stringify({ type: 'compacted' })}\n`));
  rejects(() => extractCodexNativeTurns(`${logText}\n${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  })}\n`));
  rejects(() => extractCodexNativeTurns(`${logText}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } })}\n`));
  rejects(() => extractCodexNativeTurns(`${logText}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'thread_rolled_back' } })}\n`));
});

test('Codex reader rejects a non-trailing turn without task completion', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  const turns = extractCodexNativeTurns(logText);
  const withoutFirstCompletion = lines(logText)
    .map((line) => JSON.parse(line))
    .filter((entry) => !(entry.type === 'event_msg' && entry.payload?.type === 'task_complete' &&
      entry.payload.turn_id === turns[0]!.nativeIds.completionId))
    .map((entry) => JSON.stringify(entry))
    .join('\n');

  rejects(() => extractCodexNativeTurns(`${withoutFirstCompletion}\n`));
});

test('Codex reader rejects completed lifecycle evidence without portable messages', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  const structureless = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'completed-without-messages' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'completed-without-messages' } },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  rejects(() => extractCodexNativeTurns(`${logText}\n${structureless}\n`));
});

test('Codex reader rejects missing assistant ids and out-of-order portable lifecycle records', () => {
  const started = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } };
  const user = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-a' },
    },
  };
  const assistant = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hi' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-a' },
    },
  };
  const assistantWithId = { ...assistant, payload: { ...assistant.payload, id: 'assistant-message-a' } };
  const complete = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } };
  const unrelated = { type: 'event_msg', payload: { type: 'world_state', note: true } };

  assert.equal(extractCodexNativeTurns([
    started, unrelated, user, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')).length, 1);
  rejects(() => extractCodexNativeTurns([
    started, user, assistant, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started,
    user,
    { ...assistantWithId, payload: { ...assistantWithId.payload, id: 'turn-a' } },
    complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    complete, started, user, assistantWithId,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, assistantWithId, user, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, user, complete, assistantWithId,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    user, started, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, started, user, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, user, assistantWithId, complete, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, user, assistantWithId, complete, assistantWithId,
  ].map((entry) => JSON.stringify(entry)).join('\n')));

  const startedB = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } };
  const userB = {
    ...user,
    payload: {
      ...user.payload,
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
    },
  };
  const assistantB = {
    ...assistantWithId,
    payload: {
      ...assistantWithId.payload,
      id: 'assistant-message-b',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
    },
  };
  const completeB = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } };
  rejects(() => extractCodexNativeTurns([
    started, user, startedB, userB, assistantWithId, complete, assistantB, completeB,
  ].map((entry) => JSON.stringify(entry)).join('\n')));

  const excludedForeignMessages = [
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'excluded developer context' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'one' }, { type: 'output_text', text: 'two' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
      },
    },
  ];
  assert.equal(extractCodexNativeTurns([
    started, ...excludedForeignMessages, user, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')).length, 1);
});

test('Kiro reader requires JSONL plus companion completion metadata', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companionText = validKiroCompanion(logText, await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
  const turns = extractKiroNativeTurns(logText, companionText);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.assistantText, 'REMEMBERED');
  assert.equal(turns[1]!.assistantText, 'BLUEFIN-7');
  assert.ok(turns.every((turn) => turn.nativeIds.completionId.length > 0));
});

test('Kiro reader reports malformed companion JSON as a protocol violation', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  rejects(() => extractKiroNativeTurns(logText, '{not-json'));
});

test('Kiro reader rejects non-object companion turn metadata', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  for (const malformed of [null, 1, 'metadata', []]) {
    const candidate = structuredClone(companion);
    candidate.session_state.conversation_metadata.user_turn_metadatas.push(malformed);
    rejects(() => extractKiroNativeTurns(logText, JSON.stringify(candidate)));
  }
});

test('Kiro reader rejects JSONL and companion version drift', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const versionDriftLog = lines(logText).map((line, index) => {
    const record = JSON.parse(line);
    if (index === 0) record.version = 'v2';
    return JSON.stringify(record);
  }).join('\n');
  rejects(() => extractKiroNativeTurns(`${versionDriftLog}\n`, JSON.stringify(companion)));

  companion.session_state.version = 'v2';
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(companion)));
});

test('Kiro reader binds companion metadata to the requested native session id', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const expectedSessionId = companion.session_id as string;
  assert.equal(extractKiroNativeTurns(logText, JSON.stringify(companion), expectedSessionId).length, 2);

  const wrongTopLevel = structuredClone(companion);
  wrongTopLevel.session_id = 'wrong-top-level-session';
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(wrongTopLevel), expectedSessionId));

  const wrongNested = structuredClone(companion);
  wrongNested.session_state.rts_model_state.conversation_id = 'wrong-nested-session';
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(wrongNested), expectedSessionId));

  const missingIdentity = structuredClone(companion);
  delete missingIdentity.session_id;
  delete missingIdentity.session_state.rts_model_state.conversation_id;
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(missingIdentity), expectedSessionId));
});

test('Kiro reader rejects compaction and companion drift', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const rawCompanionText = await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8');
  const companionText = validKiroCompanion(logText, rawCompanionText);
  rejects(() => extractKiroNativeTurns(`${logText}\n${JSON.stringify({ version: 'v1', kind: 'Compaction', data: {} })}\n`, companionText));
  rejects(() => extractKiroNativeTurns(logText, rawCompanionText));
  rejects(() => extractKiroNativeTurns(`${logText}\n${JSON.stringify({
    version: 'v1',
    kind: 'Prompt',
    data: {
      message_id: 'unproven-prompt',
      content: [{ kind: 'text', data: 'not in companion' }],
      meta: { timestamp: 1 },
    },
  })}\n`, companionText));
});

test('Kiro reader rejects duplicate native and completed-turn message ids', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companionText = validKiroCompanion(logText, await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
  const duplicateRecord = lines(logText).find((line) => JSON.parse(line).data?.message_id);
  assert.ok(duplicateRecord);
  rejects(() => extractKiroNativeTurns(`${logText}\n${duplicateRecord}\n`, companionText));

  const companion = JSON.parse(companionText);
  const completed = companion.session_state.conversation_metadata.user_turn_metadatas.find(
    (metadata: any) => metadata.end_reason === 'UserTurnEnd' && metadata.message_ids.length > 0,
  );
  assert.ok(completed);
  completed.message_ids.push(completed.message_ids[0]);
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(companion)));
});

test('Kiro reader binds completed companion turns to native JSONL record order', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const metadatas = companion.session_state.conversation_metadata.user_turn_metadatas;
  assert.equal(metadatas.length, 2);

  const crossedAssistants = structuredClone(companion);
  const crossed = crossedAssistants.session_state.conversation_metadata.user_turn_metadatas;
  [crossed[0].message_ids[1], crossed[1].message_ids[1]] =
    [crossed[1].message_ids[1], crossed[0].message_ids[1]];
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(crossedAssistants)));

  const reversedTurn = structuredClone(companion);
  reversedTurn.session_state.conversation_metadata.user_turn_metadatas[0].message_ids.reverse();
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(reversedTurn)));

  const reversedMetadatas = structuredClone(companion);
  reversedMetadatas.session_state.conversation_metadata.user_turn_metadatas.reverse();
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(reversedMetadatas)));
});

test('Kiro reader rejects Prompt and AssistantMessage records without native message ids', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companionText = validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  );
  for (const record of [
    {
      version: 'v1', kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'missing id' }], meta: { timestamp: 1 } },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'missing id' }] },
    },
  ]) {
    rejects(() => extractKiroNativeTurns(
      `${logText.trimEnd()}\n${JSON.stringify(record)}\n`,
      companionText,
    ));
  }
});

test('Kiro reader requires a completion boundary id in completed metadata', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  delete companion.session_state.conversation_metadata.user_turn_metadatas[0].result.Ok.id;
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(companion)));

  const missingResult = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  delete missingResult.session_state.conversation_metadata.user_turn_metadatas[0].result;
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(missingResult)));
});

test('Kiro reader rejects malformed completed message_ids instead of filtering them', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const mixedIds = structuredClone(companion);
  mixedIds.session_state.conversation_metadata.user_turn_metadatas[0].message_ids.push(123);
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(mixedIds)));

  const missingIds = structuredClone(companion);
  delete missingIds.session_state.conversation_metadata.user_turn_metadatas[0].message_ids;
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(missingIds)));

  const emptyIds = structuredClone(companion);
  emptyIds.session_state.conversation_metadata.user_turn_metadatas.push({
    message_ids: [],
    end_reason: 'UserTurnEnd',
    result: { Ok: { id: 'empty-completed-turn' } },
  });
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(emptyIds)));
});

test('Kiro reader rejects missing message ids referenced by incomplete metadata', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  companion.session_state.conversation_metadata.user_turn_metadatas.push({
    message_ids: ['missing-native-id'],
    end_reason: 'Pending',
  });

  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(companion)));
});

test('Kiro reader does not infer unverified result snapshot semantics beyond the completion id', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const firstAssistant = lines(logText).map((line) => JSON.parse(line))
    .find((entry) => entry.kind === 'AssistantMessage');
  assert.ok(firstAssistant);
  const extraAssistant = structuredClone(firstAssistant);
  extraAssistant.data.message_id = 'extra-assistant-message';
  extraAssistant.data.content[0].data = 'follow-up assistant text';
  companion.session_state.conversation_metadata.user_turn_metadatas[0].message_ids.push(
    extraAssistant.data.message_id,
  );
  companion.session_state.conversation_metadata.user_turn_metadatas[0].result.Ok.role = 'unverified-role-field';
  companion.session_state.conversation_metadata.user_turn_metadatas[0].result.Ok.content[0].data = 'unverified snapshot';
  companion.session_state.conversation_metadata.user_turn_metadatas[0].result.Ok.meta.timestamp = 'unverified timestamp';

  const orderedLog = lines(logText);
  const firstTurnLastMessageId = companion.session_state.conversation_metadata
    .user_turn_metadatas[0].message_ids.at(-2);
  const insertAfter = orderedLog.findIndex((line) => JSON.parse(line).data?.message_id === firstTurnLastMessageId);
  assert.ok(insertAfter >= 0);
  orderedLog.splice(insertAfter + 1, 0, JSON.stringify(extraAssistant));

  const turns = extractKiroNativeTurns(
    `${orderedLog.join('\n')}\n`,
    JSON.stringify(companion),
  );
  assert.equal(turns[0]!.assistantText.endsWith('\n\nfollow-up assistant text'), true);
  assert.equal(turns[0]!.nativeIds.completionId.length > 0, true);
});

test('Kiro reader rejects completed metadata id reuse across completed turns', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const reusedMessageId = structuredClone(companion);
  reusedMessageId.session_state.conversation_metadata.user_turn_metadatas[1].message_ids[0] =
    reusedMessageId.session_state.conversation_metadata.user_turn_metadatas[0].message_ids[0];
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(reusedMessageId)));

  const reusedCompletionId = structuredClone(companion);
  reusedCompletionId.session_state.conversation_metadata.user_turn_metadatas[1].result.Ok.id =
    reusedCompletionId.session_state.conversation_metadata.user_turn_metadatas[0].result.Ok.id;
  rejects(() => extractKiroNativeTurns(logText, JSON.stringify(reusedCompletionId)));

  const completionReusedAsMessage = structuredClone(companion);
  const priorCompletionId = completionReusedAsMessage.session_state.conversation_metadata
    .user_turn_metadatas[0].result.Ok.id;
  const replacedMessageId = completionReusedAsMessage.session_state.conversation_metadata
    .user_turn_metadatas[1].message_ids[0];
  completionReusedAsMessage.session_state.conversation_metadata.user_turn_metadatas[1].message_ids[0] =
    priorCompletionId;
  const remappedLog = lines(logText).map((line) => {
    const record = JSON.parse(line);
    if (record.data?.message_id === replacedMessageId) record.data.message_id = priorCompletionId;
    return JSON.stringify(record);
  }).join('\n');
  rejects(() => extractKiroNativeTurns(remappedLog, JSON.stringify(completionReusedAsMessage)));
});

test('Kiro reader rejects a completed partial portable pair but excludes completed tool-only metadata', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const promptOnly = {
    version: 'v1', kind: 'Prompt',
    data: {
      message_id: 'prompt-only',
      content: [{ kind: 'text', data: 'caller text' }],
      meta: { timestamp: 1 },
    },
  };
  const partialCompanion = structuredClone(companion);
  partialCompanion.session_state.conversation_metadata.user_turn_metadatas.push({
    message_ids: ['prompt-only'],
    end_reason: 'UserTurnEnd',
    result: { Ok: { id: 'prompt-only-completion' } },
  });
  rejects(() => extractKiroNativeTurns(
    `${logText}\n${JSON.stringify(promptOnly)}\n`,
    JSON.stringify(partialCompanion),
  ));

  const textPromptWithoutMeta: any = structuredClone(promptOnly);
  textPromptWithoutMeta.data.message_id = 'text-prompt-without-meta';
  delete textPromptWithoutMeta.data.meta;
  const malformedPromptCompanion = structuredClone(companion);
  malformedPromptCompanion.session_state.conversation_metadata.user_turn_metadatas.push({
    message_ids: ['text-prompt-without-meta'],
    end_reason: 'UserTurnEnd',
    result: { Ok: { id: 'text-prompt-without-meta-completion' } },
  });
  rejects(() => extractKiroNativeTurns(
    `${logText}\n${JSON.stringify(textPromptWithoutMeta)}\n`,
    JSON.stringify(malformedPromptCompanion),
  ));

  const toolOnly = {
    version: 'v1', kind: 'ToolResults',
    data: { message_id: 'tool-only', content: [{ kind: 'toolResult', data: 'diagnostic' }] },
  };
  const toolCompanion = structuredClone(companion);
  toolCompanion.session_state.conversation_metadata.user_turn_metadatas.push({
    message_ids: ['tool-only'],
    end_reason: 'UserTurnEnd',
    result: { Ok: { id: 'tool-only-completion' } },
  });
  assert.equal(extractKiroNativeTurns(
    `${logText}\n${JSON.stringify(toolOnly)}\n`,
    JSON.stringify(toolCompanion),
  ).length, 2);
});

test('Kiro reader extracts text from mixed text/toolUse assistant messages like the live turn path', () => {
  const records = [
    {
      version: 'v1', kind: 'Prompt',
      data: {
        message_id: 'mixed-prompt',
        content: [{ kind: 'text', data: 'run the tool workflow' }],
        meta: { timestamp: 1 },
      },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: {
        message_id: 'mixed-assistant-1',
        content: [{ kind: 'text', data: 'A' }, { kind: 'toolUse', data: { name: 'fsRead' } }],
      },
    },
    {
      version: 'v1', kind: 'ToolResults',
      data: { message_id: 'mixed-tool-results-1', content: [{ kind: 'toolResult', data: 'ok' }] },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: {
        message_id: 'mixed-assistant-2',
        content: [{ kind: 'text', data: 'B' }, { kind: 'toolUse', data: { name: 'fsWrite' } }],
      },
    },
    {
      version: 'v1', kind: 'ToolResults',
      data: { message_id: 'mixed-tool-results-2', content: [{ kind: 'toolResult', data: 'ok' }] },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: { message_id: 'mixed-assistant-3', content: [{ kind: 'text', data: 'C' }] },
    },
  ];
  const companion = {
    session_state: {
      version: 'v1',
      conversation_metadata: {
        user_turn_metadatas: [{
          message_ids: [
            'mixed-prompt', 'mixed-assistant-1', 'mixed-tool-results-1',
            'mixed-assistant-2', 'mixed-tool-results-2', 'mixed-assistant-3',
          ],
          end_reason: 'UserTurnEnd',
          result: { Ok: { id: 'mixed-completion' } },
        }],
      },
    },
  };
  const turns = extractKiroNativeTurns(
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    JSON.stringify(companion),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'run the tool workflow');
  assert.equal(turns[0]!.assistantText, 'A\n\nB\n\nC');
  assert.deepEqual(
    turns[0]!.nativeIds.assistantIds,
    ['mixed-assistant-1', 'mixed-assistant-2', 'mixed-assistant-3'],
  );
  assert.equal(turns[0]!.nativeIds.userId, 'mixed-prompt');
  assert.equal(turns[0]!.nativeIds.completionId, 'mixed-completion');
});

test('Kiro reader excludes empty-text tool-use assistant messages like the live turn path', () => {
  // Raw evidence shape: tool-use assistant messages carry
  // an empty text block, and only the final answer message carries non-empty text.
  const records = [
    {
      version: 'v1', kind: 'Prompt',
      data: {
        message_id: 'empty-text-prompt',
        content: [{ kind: 'text', data: 'run the tool workflow' }],
        meta: { timestamp: 1 },
      },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: {
        message_id: 'empty-text-assistant-1',
        content: [{ kind: 'text', data: '' }, { kind: 'toolUse', data: { name: 'read' } }],
      },
    },
    {
      version: 'v1', kind: 'ToolResults',
      data: { message_id: 'empty-text-tool-results-1', content: [{ kind: 'toolResult', data: 'ok' }] },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: {
        message_id: 'empty-text-assistant-2',
        content: [{ kind: 'text', data: '' }, { kind: 'toolUse', data: { name: 'write' } }],
      },
    },
    {
      version: 'v1', kind: 'ToolResults',
      data: { message_id: 'empty-text-tool-results-2', content: [{ kind: 'toolResult', data: 'ok' }] },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: { message_id: 'empty-text-assistant-3', content: [{ kind: 'text', data: '답변' }] },
    },
  ];
  const companion = {
    session_state: {
      version: 'v1',
      conversation_metadata: {
        user_turn_metadatas: [{
          message_ids: [
            'empty-text-prompt', 'empty-text-assistant-1', 'empty-text-tool-results-1',
            'empty-text-assistant-2', 'empty-text-tool-results-2', 'empty-text-assistant-3',
          ],
          end_reason: 'UserTurnEnd',
          result: { Ok: { id: 'empty-text-completion' } },
        }],
      },
    },
  };
  const turns = extractKiroNativeTurns(
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    JSON.stringify(companion),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.assistantText, '답변');
  assert.deepEqual(turns[0]!.nativeIds.assistantIds, ['empty-text-assistant-3']);
});

test('Kiro reader excludes tool-only completed metadata whose assistant carries an empty text block', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const toolOnlyRecords = [
    {
      version: 'v1', kind: 'AssistantMessage',
      data: {
        message_id: 'tool-only-empty-text-assistant',
        content: [{ kind: 'text', data: '' }, { kind: 'toolUse', data: { name: 'read' } }],
      },
    },
    {
      version: 'v1', kind: 'ToolResults',
      data: { message_id: 'tool-only-empty-text-results', content: [{ kind: 'toolResult', data: 'ok' }] },
    },
  ].map((record) => JSON.stringify(record)).join('\n');
  companion.session_state.conversation_metadata.user_turn_metadatas.push({
    message_ids: ['tool-only-empty-text-assistant', 'tool-only-empty-text-results'],
    end_reason: 'UserTurnEnd',
    result: { Ok: { id: 'tool-only-empty-text-completion' } },
  });

  assert.equal(extractKiroNativeTurns(
    `${logText}\n${toolOnlyRecords}\n`,
    JSON.stringify(companion),
  ).length, 2);
});

test('Kiro reader rejects a text content block whose data is not a string', () => {
  const records = [
    {
      version: 'v1', kind: 'Prompt',
      data: {
        message_id: 'malformed-prompt',
        content: [{ kind: 'text', data: 'caller text' }],
        meta: { timestamp: 1 },
      },
    },
    {
      version: 'v1', kind: 'AssistantMessage',
      data: { message_id: 'valid-assistant', content: [{ kind: 'text', data: 'A' }] },
    },
    // Must reject instead of silently skipping the malformed record and extracting only 'A'.
    {
      version: 'v1', kind: 'AssistantMessage',
      data: { message_id: 'malformed-assistant', content: [{ kind: 'text', data: 42 }] },
    },
  ];
  const companion = {
    session_state: {
      version: 'v1',
      conversation_metadata: {
        user_turn_metadatas: [{
          message_ids: ['malformed-prompt', 'valid-assistant', 'malformed-assistant'],
          end_reason: 'UserTurnEnd',
          result: { Ok: { id: 'malformed-completion' } },
        }],
      },
    },
  };
  rejects(() => extractKiroNativeTurns(
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    JSON.stringify(companion),
  ));
});

test('Kiro reader rejects an unreferenced mixed assistant message with text content', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companionText = validKiroCompanion(logText, await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
  const unprovenMixed = JSON.stringify({
    version: 'v1', kind: 'AssistantMessage',
    data: {
      message_id: 'unproven-mixed-assistant',
      content: [{ kind: 'text', data: 'not in companion' }, { kind: 'toolUse', data: { name: 'fsRead' } }],
    },
  });
  rejects(() => extractKiroNativeTurns(`${logText}\n${unprovenMixed}\n`, companionText));
});

test('native JSONL readers reject valid JSON non-object records', async () => {
  const kiroLog = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const kiroCompanion = validKiroCompanion(
    kiroLog,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  );
  for (const record of ['null', '[]', '42']) {
    rejects(() => extractClaudeNativeTurns(`${record}\n`));
    rejects(() => extractCodexNativeTurns(`${record}\n`));
    rejects(() => extractKiroNativeTurns(`${record}\n`, kiroCompanion));
  }
});

test('OpenCode reader extracts completed exported pairs and drops trailing incomplete user messages', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  const before = JSON.stringify(exportDoc);
  exportDoc.messages.push({
    info: { id: 'msg_f60012b56001AAAAAAAAAAAAAA', role: 'user' },
    parts: [{ id: 'prt_f60012b57001AAAAAAAAAAAAAA', type: 'text', text: 'unfinished' }],
  });
  const withTrailingUser = JSON.stringify(exportDoc);
  const turns = extractOpenCodeNativeTurns(withTrailingUser);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.assistantText.trim(), 'OK');
  assert.equal(turns[0]!.nativeIds.assistantIds.length, 1);
  assert.notEqual(openCodeNativeStateDigest(withTrailingUser), openCodeNativeStateDigest(before));
});

test('native state digests cover every backend-owned component but ignore OpenCode object key order', async () => {
  const kiroLog = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const kiroCompanion = await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8');
  assert.notEqual(
    kiroNativeStateDigest(Buffer.from(kiroLog), Buffer.from(kiroCompanion)),
    kiroNativeStateDigest(Buffer.from(`${kiroLog}\n`), Buffer.from(kiroCompanion)),
  );
  assert.notEqual(
    kiroNativeStateDigest(Buffer.from(kiroLog), Buffer.from(kiroCompanion)),
    kiroNativeStateDigest(Buffer.from(kiroLog), Buffer.from(`${kiroCompanion}\n`)),
  );

  const first = '{"messages":[{"info":{"role":"user","id":"one"},"parts":[]}]}';
  const reorderedKeys = '{"messages":[{"parts":[],"info":{"id":"one","role":"user"}}]}';
  const changedArray = '{"messages":[{"info":{"role":"user","id":"one"},"parts":[null]}]}';
  assert.equal(openCodeNativeStateDigest(first), openCodeNativeStateDigest(reorderedKeys));
  assert.notEqual(openCodeNativeStateDigest(first), openCodeNativeStateDigest(changedArray));
});

test('native state byte digests distinguish invalid UTF-8 that lossy decoding would merge', () => {
  const first = Buffer.from([0x22, 0x80, 0x22]);
  const second = Buffer.from([0x22, 0x81, 0x22]);
  assert.equal(first.toString('utf8'), second.toString('utf8'));
  assert.notEqual(digestNativeState('invalid-byte-probe', [first]), digestNativeState('invalid-byte-probe', [second]));
  assert.throws(
    () => decodeNativeStateUtf8(first, 'test native state'),
    (error) => error instanceof OpenPError && error.exitCode === 40,
  );
});

test('OpenCode reader validates export document info.id against the requested session id', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  assert.equal(extractOpenCodeNativeTurns(JSON.stringify(exportDoc), exportDoc.info.id).length, 1);
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(exportDoc), 'different-session'));

  const wrongMessageOwner = structuredClone(exportDoc);
  wrongMessageOwner.messages[0].info.sessionID = 'different-session';
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(wrongMessageOwner), exportDoc.info.id));

  const wrongPartOwner = structuredClone(exportDoc);
  wrongPartOwner.messages[0].parts[0].sessionID = 'different-session';
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(wrongPartOwner), exportDoc.info.id));

  const wrongPartMessage = structuredClone(exportDoc);
  wrongPartMessage.messages[0].parts[0].messageID = wrongPartMessage.messages[1].info.id;
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(wrongPartMessage), exportDoc.info.id));
});

test('OpenCode reader rejects missing, malformed, and unsupported export versions', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  for (const version of [undefined, 1, '99.0.0']) {
    const candidate = structuredClone(exportDoc);
    if (version === undefined) {
      delete candidate.info.version;
    } else {
      candidate.info.version = version;
    }
    rejects(() => extractOpenCodeNativeTurns(JSON.stringify(candidate), candidate.info.id));
  }
});

test('OpenCode reader rejects malformed or duplicate native message and part ids', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  const corruptions: readonly ((doc: any) => void)[] = [
    (doc) => { doc.messages[0].info.id = 'msg_not-native'; },
    (doc) => { delete doc.messages[0].parts[0].id; },
    (doc) => { doc.messages[1].info.id = doc.messages[0].info.id; },
    (doc) => { doc.messages[1].parts[0].id = doc.messages[0].parts[0].id; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(exportDoc);
    corrupt(candidate);
    rejects(() => extractOpenCodeNativeTurns(JSON.stringify(candidate)));
  }
});

test('OpenCode reader rejects pending revert and every native compaction marker', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  const reverted = structuredClone(exportDoc);
  reverted.info.revert = { messageID: reverted.messages[0].info.id };
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(reverted)));

  const compacting = structuredClone(exportDoc);
  compacting.info.time.compacting = compacting.info.time.updated;
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(compacting)));

  const compacted = structuredClone(exportDoc);
  compacted.messages[0].parts.push({
    id: 'prt_f60012997001AAAAAAAAAAAAAA',
    sessionID: compacted.info.id,
    messageID: compacted.messages[0].info.id,
    type: 'compaction',
    auto: true,
  });
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(compacted)));

  const summaryAssistant = structuredClone(exportDoc);
  summaryAssistant.messages[1].info.summary = true;
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(summaryAssistant)));

  const nonAdjacent = structuredClone(exportDoc);
  nonAdjacent.messages.splice(1, 0, {
    info: { id: 'msg_f60012a00001AAAAAAAAAAAAAA', role: 'system' },
    parts: [],
  });
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(nonAdjacent)));

  const consecutiveUsers = structuredClone(exportDoc);
  consecutiveUsers.messages.splice(1, 0, {
    info: { id: 'msg_f60012a10001AAAAAAAAAAAAAA', role: 'user' },
    parts: [{ id: 'prt_f60012a20001AAAAAAAAAAAAAA', type: 'text', text: 'second pending user' }],
  });
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(consecutiveUsers)));

  const middleIncomplete = structuredClone(exportDoc);
  delete middleIncomplete.messages[1].info.time.completed;
  middleIncomplete.messages.push(
    {
      info: { id: 'msg_f60012a30001AAAAAAAAAAAAAA', role: 'user' },
      parts: [{ id: 'prt_f60012a40001AAAAAAAAAAAAAA', type: 'text', text: 'later user' }],
    },
    {
      info: {
        id: 'msg_f60012a50001AAAAAAAAAAAAAA', role: 'assistant',
        parentID: 'msg_f60012a30001AAAAAAAAAAAAAA', finish: 'stop',
        time: { created: 1784022154547, completed: 1784022154548 },
      },
      parts: [{ id: 'prt_f60012a60001AAAAAAAAAAAAAA', type: 'text', text: 'later answer' }],
    },
  );
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(middleIncomplete)));
});

test('OpenCode reader binds every assistant subturn to its user and keeps the terminal completion id', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  const user = exportDoc.messages[0];
  const finalAssistant = exportDoc.messages[1];
  finalAssistant.parts.find((part: any) => part.type === 'text').text = 'final answer';
  const intermediate = structuredClone(finalAssistant);
  intermediate.info.id = 'msg_f60012a00001AAAAAAAAAAAAAA';
  intermediate.info.parentID = user.info.id;
  intermediate.info.finish = 'tool-calls';
  intermediate.info.time = { created: finalAssistant.info.time.created - 2, completed: finalAssistant.info.time.created - 1 };
  intermediate.parts = [{
    id: 'prt_f60012a10001AAAAAAAAAAAAAA',
    sessionID: exportDoc.info.id,
    messageID: intermediate.info.id,
    type: 'text',
    text: 'intermediate answer',
  }];
  exportDoc.messages = [user, intermediate, finalAssistant];

  const turns = extractOpenCodeNativeTurns(JSON.stringify(exportDoc), exportDoc.info.id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.assistantText, 'final answer');
  assert.deepEqual(turns[0]!.nativeIds.assistantIds, [intermediate.info.id, finalAssistant.info.id]);
  assert.equal(turns[0]!.nativeIds.completionId, finalAssistant.info.id);

  const malformedSibling = structuredClone(exportDoc);
  malformedSibling.messages[1].info.finish = 'stop';
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(malformedSibling), malformedSibling.info.id));

  const toolContinuedSibling = structuredClone(malformedSibling);
  toolContinuedSibling.messages[1].parts.push({
    id: 'prt_f60012a20001AAAAAAAAAAAAAA',
    sessionID: toolContinuedSibling.info.id,
    messageID: toolContinuedSibling.messages[1].info.id,
    type: 'tool',
    callID: 'call-intermediate',
    tool: 'read',
    state: { status: 'completed', input: {}, output: 'done', title: 'read', metadata: {}, time: { start: 1, end: 2 } },
  });
  assert.equal(extractOpenCodeNativeTurns(
    JSON.stringify(toolContinuedSibling),
    toolContinuedSibling.info.id,
  ).length, 1);

  for (const corrupt of [
    (doc: any) => { delete doc.messages[1].info.parentID; },
    (doc: any) => { doc.messages[1].info.parentID = 'msg_f60012a20001AAAAAAAAAAAAAA'; },
  ]) {
    const candidate = structuredClone(exportDoc);
    corrupt(candidate);
    rejects(() => extractOpenCodeNativeTurns(JSON.stringify(candidate), candidate.info.id));
  }
});

test('OpenCode reader excludes explicit provider-error turns and rejects false completion evidence', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  const interrupted = structuredClone(exportDoc);
  interrupted.messages[1].info.error = { name: 'ProviderError', data: { message: 'redacted' } };
  assert.deepEqual(extractOpenCodeNativeTurns(JSON.stringify(interrupted), interrupted.info.id), []);

  const assistantAfterError = structuredClone(exportDoc);
  const errorIntermediate = structuredClone(assistantAfterError.messages[1]);
  errorIntermediate.info.id = 'msg_f60012ab0001AAAAAAAAAAAAAA';
  errorIntermediate.info.error = { name: 'ProviderError', data: { message: 'redacted' } };
  errorIntermediate.parts = [{
    id: 'prt_f60012ac0001AAAAAAAAAAAAAA',
    sessionID: assistantAfterError.info.id,
    messageID: errorIntermediate.info.id,
    type: 'text',
    text: 'partial',
  }];
  assistantAfterError.messages.splice(1, 0, errorIntermediate);
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(assistantAfterError), assistantAfterError.info.id));

  const missingFinish = structuredClone(exportDoc);
  delete missingFinish.messages[1].info.finish;
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(missingFinish), missingFinish.info.id));

  const unfinishedToolCall = structuredClone(exportDoc);
  unfinishedToolCall.messages[1].info.finish = 'tool-calls';
  assert.deepEqual(extractOpenCodeNativeTurns(JSON.stringify(unfinishedToolCall), unfinishedToolCall.info.id), []);

  const nonTrailingToolCall = structuredClone(unfinishedToolCall);
  const nextUser = structuredClone(nonTrailingToolCall.messages[0]);
  nextUser.info.id = 'msg_f60012c00001AAAAAAAAAAAAAA';
  nextUser.parts[0].id = 'prt_f60012c10001AAAAAAAAAAAAAA';
  nextUser.parts[0].messageID = nextUser.info.id;
  nextUser.parts[0].text = 'later user';
  nonTrailingToolCall.messages.push(nextUser);
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(nonTrailingToolCall), nonTrailingToolCall.info.id));

  for (const finish of ['unknown', 'content-filter', 'error']) {
    const unsupportedFinish = structuredClone(exportDoc);
    unsupportedFinish.messages[1].info.finish = finish;
    rejects(() => extractOpenCodeNativeTurns(JSON.stringify(unsupportedFinish), unsupportedFinish.info.id));
  }

  const pendingTool = structuredClone(exportDoc);
  pendingTool.messages[1].parts.push({
    id: 'prt_f60012a80001AAAAAAAAAAAAAA',
    sessionID: pendingTool.info.id,
    messageID: pendingTool.messages[1].info.id,
    type: 'tool',
    callID: 'call-1',
    tool: 'read',
    state: { status: 'pending', input: {}, raw: '{}' },
  });
  assert.deepEqual(extractOpenCodeNativeTurns(JSON.stringify(pendingTool), pendingTool.info.id), []);

  const providerExecuted = structuredClone(pendingTool);
  providerExecuted.messages[1].parts.at(-1).metadata = { providerExecuted: true };
  assert.equal(extractOpenCodeNativeTurns(JSON.stringify(providerExecuted), providerExecuted.info.id).length, 1);
});

test('OpenCode reader excludes synthetic internal user text from caller IR', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  const userTextPart = exportDoc.messages[0].parts.find((part: any) => part.type === 'text');
  userTextPart.synthetic = true;
  assert.deepEqual(extractOpenCodeNativeTurns(JSON.stringify(exportDoc), exportDoc.info.id), []);

  const mixed = structuredClone(exportDoc);
  mixed.messages[0].parts.push({
    id: 'prt_f60012a70001AAAAAAAAAAAAAA',
    sessionID: mixed.info.id,
    messageID: mixed.messages[0].info.id,
    type: 'text',
    text: 'real caller text',
  });
  const turns = extractOpenCodeNativeTurns(JSON.stringify(mixed), mixed.info.id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'real caller text');
});

test('OpenCode settlement validates both exports before accepting an equal messages digest', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  assert.doesNotThrow(() => assertStableOpenCodeNativeExports(
    JSON.stringify(exportDoc),
    JSON.stringify(exportDoc),
    exportDoc.info.id,
  ));

  const revertedFirst = structuredClone(exportDoc);
  revertedFirst.info.revert = { messageID: revertedFirst.messages[0].info.id };
  assert.equal(
    openCodeNativeStateDigest(JSON.stringify(revertedFirst)),
    openCodeNativeStateDigest(JSON.stringify(exportDoc)),
  );
  rejects(() => assertStableOpenCodeNativeExports(
    JSON.stringify(revertedFirst),
    JSON.stringify(exportDoc),
    exportDoc.info.id,
  ));

  const compactingFirst = structuredClone(exportDoc);
  compactingFirst.info.time.compacting = compactingFirst.info.time.updated;
  rejects(() => assertStableOpenCodeNativeExports(
    JSON.stringify(compactingFirst),
    JSON.stringify(exportDoc),
    exportDoc.info.id,
  ));
});

test('OpenCode export maps an abort-caused signal to AbortError', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => assertOpenCodeExportOk({
      stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: false,
    }, controller.signal),
    isAbortError,
  );
});
