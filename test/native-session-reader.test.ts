import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { extractClaudeNativeTurns } from '../src/backends/claude/native-reader.js';
import { extractCodexNativeTurns } from '../src/backends/codex/native-reader.js';
import { extractKiroNativeTurns } from '../src/backends/kiro/native-reader.js';
import { assertOpenCodeExportOk, extractOpenCodeNativeTurns } from '../src/backends/opencode/native-reader.js';
import { isAbortError } from '../src/core/abort.js';
import { OpenPError } from '../src/core/errors.js';

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
  const turns = extractClaudeNativeTurns(`${logText}\n${trailingUser}\n`);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.assistantText, 'REMEMBERED');
  assert.equal(turns[1]!.assistantText, 'BLUEFIN-7');
  assert.ok(turns.every((turn) => turn.nativeIds.userId.length > 0 && turn.nativeIds.assistantIds.length === 1));

  const withoutLastCompletion = lines(logText)
    .map((line) => JSON.parse(line))
    .filter((entry) => !(entry.type === 'system' && entry.subtype === 'turn_duration' &&
      entry.uuid === turns[1]!.nativeIds.completionId))
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  assert.equal(extractClaudeNativeTurns(`${withoutLastCompletion}\n`).length, 1);
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
  const turns = extractCodexNativeTurns(`${logText}\n${trailingUser}\n`);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.assistantText, 'REMEMBERED');
  assert.equal(turns[1]!.assistantText, 'BLUEFIN-7');
  assert.ok(turns.every((turn) => turn.nativeIds.completionId.length > 0));

  const withoutLastCompletion = lines(logText)
    .map((line) => JSON.parse(line))
    .filter((entry) => !(entry.type === 'event_msg' && entry.payload?.type === 'task_complete' &&
      entry.payload.turn_id === turns[1]!.nativeIds.completionId))
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  assert.equal(extractCodexNativeTurns(`${withoutLastCompletion}\n`).length, 1);
});

test('Codex reader rejects compaction, aborted turns, and rollback markers', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  rejects(() => extractCodexNativeTurns(`${logText}\n${JSON.stringify({ type: 'compacted' })}\n`));
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
  exportDoc.messages.push({
    info: { id: 'msg_f60012b56001AAAAAAAAAAAAAA', role: 'user' },
    parts: [{ id: 'prt_f60012b57001AAAAAAAAAAAAAA', type: 'text', text: 'unfinished' }],
  });
  const turns = extractOpenCodeNativeTurns(JSON.stringify(exportDoc));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.assistantText.trim(), 'OK');
  assert.equal(turns[0]!.nativeIds.assistantIds.length, 1);
});

test('OpenCode reader rejects pending revert and compaction parts', async () => {
  const exportDoc = JSON.parse(await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  const reverted = structuredClone(exportDoc);
  reverted.messages[0].info.revert = { messageID: 'x' };
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(reverted)));

  const compacted = structuredClone(exportDoc);
  compacted.messages[0].parts.push({ id: 'prt_compact', type: 'compaction', text: 'summary' });
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(compacted)));

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
        time: { created: 1784022154547, completed: 1784022154548 },
      },
      parts: [{ id: 'prt_f60012a60001AAAAAAAAAAAAAA', type: 'text', text: 'later answer' }],
    },
  );
  rejects(() => extractOpenCodeNativeTurns(JSON.stringify(middleIncomplete)));
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
