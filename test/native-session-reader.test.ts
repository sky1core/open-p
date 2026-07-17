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
import {
  assertKiroNativeSessionAppendable,
  extractKiroNativeTurns,
  kiroNativeStateDigest,
} from '../src/backends/kiro/native-reader.js';
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

function claudeCompactionBoundaryRecords(prefix: string, summaryText: string): object[] {
  return [
    { type: 'system', subtype: 'compact_boundary', uuid: `${prefix}-boundary`, parentUuid: null },
    {
      type: 'user', isCompactSummary: true, uuid: `${prefix}-summary`, parentUuid: `${prefix}-boundary`,
      message: { role: 'user', content: summaryText },
    },
  ];
}

function claudeCompletedTurnRecords(prefix: string, parentUuid: string, prompt: string, answer: string): object[] {
  return [
    { type: 'user', uuid: `${prefix}-user`, parentUuid, message: { role: 'user', content: prompt } },
    {
      type: 'assistant', uuid: `${prefix}-assistant`, parentUuid: `${prefix}-user`,
      message: { id: `${prefix}-message`, role: 'assistant', content: [{ type: 'text', text: answer }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: `${prefix}-completion`,
      parentUuid: `${prefix}-assistant`, durationMs: 1,
    },
  ];
}

test('Claude reader recovers completed turns across a compact boundary and never emits the summary', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const compacted = [
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY: earlier turns condensed'),
    ...claudeCompletedTurnRecords('post-compact-1', 'compact-1-summary', 'third prompt', 'THIRD-ANSWER'),
    ...claudeCompletedTurnRecords('post-compact-2', 'post-compact-1-completion', 'fourth prompt', 'FOURTH-ANSWER'),
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${compacted}\n`);
  assert.equal(turns.length, 4);
  assert.deepEqual(
    turns.map((turn) => turn.assistantText),
    ['REMEMBERED', 'BLUEFIN-7', 'THIRD-ANSWER', 'FOURTH-ANSWER'],
  );
  assert.equal(turns[2]!.userText, 'third prompt');
  assert.equal(turns[3]!.userText, 'fourth prompt');
  assert.equal(turns[2]!.nativeIds.userId, 'post-compact-1-user');
  assert.deepEqual(turns[2]!.nativeIds.assistantIds, ['post-compact-1-message']);
  assert.equal(turns[2]!.nativeIds.completionId, 'post-compact-1-completion');
  assert.ok(!JSON.stringify(turns).includes('COMPACT-SUMMARY'), 'compaction summary content must never appear in any turn');
});

test('Claude reader recovers turns from every segment across multiple compact boundaries in file order', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const compacted = [
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY-ONE'),
    ...claudeCompletedTurnRecords('segment-1', 'compact-1-summary', 'third prompt', 'THIRD-ANSWER'),
    ...claudeCompactionBoundaryRecords('compact-2', 'COMPACT-SUMMARY-TWO'),
    ...claudeCompletedTurnRecords('segment-2', 'compact-2-summary', 'fourth prompt', 'FOURTH-ANSWER'),
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${compacted}\n`);
  assert.equal(turns.length, 4);
  assert.deepEqual(
    turns.map((turn) => [turn.userText, turn.assistantText]).slice(2),
    [['third prompt', 'THIRD-ANSWER'], ['fourth prompt', 'FOURTH-ANSWER']],
  );
  assert.deepEqual(
    turns.map((turn) => turn.assistantText),
    ['REMEMBERED', 'BLUEFIN-7', 'THIRD-ANSWER', 'FOURTH-ANSWER'],
  );
  assert.ok(!JSON.stringify(turns).includes('COMPACT-SUMMARY'), 'no segment may emit a compaction summary');
});

test('Claude reader extracts only the active branch inside a compacted segment', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const compacted = [
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY'),
    { type: 'user', uuid: 'rewound-user', parentUuid: 'compact-1-summary', message: { role: 'user', content: 'branched prompt' } },
    {
      type: 'assistant', uuid: 'abandoned-assistant', parentUuid: 'rewound-user',
      message: { id: 'abandoned-message', role: 'assistant', content: [{ type: 'text', text: 'ABANDONED-ANSWER' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'abandoned-completion',
      parentUuid: 'abandoned-assistant', durationMs: 1,
    },
    {
      type: 'assistant', uuid: 'active-assistant', parentUuid: 'rewound-user',
      message: { id: 'active-message', role: 'assistant', content: [{ type: 'text', text: 'ACTIVE-ANSWER' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'active-completion',
      parentUuid: 'active-assistant', durationMs: 1,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${compacted}\n`);
  assert.equal(turns.length, 3);
  assert.equal(turns[2]!.userText, 'branched prompt');
  assert.equal(turns[2]!.assistantText, 'ACTIVE-ANSWER');
  assert.deepEqual(turns[2]!.nativeIds.assistantIds, ['active-message']);
  assert.equal(turns[2]!.nativeIds.completionId, 'active-completion');
  assert.ok(!JSON.stringify(turns).includes('ABANDONED-ANSWER'), 'abandoned branch turns must not be recovered');
});

test('Claude reader drops a segment-trailing incomplete turn at a compact boundary', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const compacted = [
    { type: 'user', uuid: 'pending-user', parentUuid: lastUuid(logText), message: { role: 'user', content: 'PENDING-PROMPT' } },
    {
      type: 'assistant', uuid: 'pending-assistant', parentUuid: 'pending-user',
      message: { id: 'pending-message', role: 'assistant', content: [{ type: 'text', text: 'PENDING-ANSWER' }] },
    },
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY'),
    ...claudeCompletedTurnRecords('post-compact-1', 'compact-1-summary', 'third prompt', 'THIRD-ANSWER'),
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${compacted}\n`);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((turn) => turn.assistantText), ['REMEMBERED', 'BLUEFIN-7', 'THIRD-ANSWER']);
  assert.ok(!JSON.stringify(turns).includes('PENDING-'), 'a segment-trailing incomplete turn must be dropped, not completed');
});

// On the pre-segment reader these inputs never reached the lineage/uuid checks (any compact_boundary
// was rejected outright), so discrimination is carried by the current-code pass/fail expectations.
test('Claude reader fails closed when a compacted segment record chains outside its segment', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');

  // Backward escape: a post-compaction turn whose parentUuid points at a pre-boundary record. The
  // segment-scoped walk must treat the out-of-segment parent as missing lineage (exit 40), locking
  // the spec clause "staying within the segment".
  const backwardEscape = [
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY'),
    ...claudeCompletedTurnRecords('escaped', lastUuid(logText), 'escaped prompt', 'ESCAPED-ANSWER'),
  ].map((entry) => JSON.stringify(entry)).join('\n');
  rejects(() => extractClaudeNativeTurns(`${logText}\n${backwardEscape}\n`));

  // Forward escape: a segment record whose parentUuid points into a later segment.
  const forwardEscape = [
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY-ONE'),
    ...claudeCompletedTurnRecords('forward', 'compact-2-summary', 'forward prompt', 'FORWARD-ANSWER'),
    ...claudeCompactionBoundaryRecords('compact-2', 'COMPACT-SUMMARY-TWO'),
    ...claudeCompletedTurnRecords('segment-2', 'compact-2-summary', 'later prompt', 'LATER-ANSWER'),
  ].map((entry) => JSON.stringify(entry)).join('\n');
  rejects(() => extractClaudeNativeTurns(`${logText}\n${forwardEscape}\n`));
});

test('Claude reader rejects a uuid duplicated across compaction segments', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  // A post-compaction record replaying a pre-boundary uuid (a hypothetical preserved-record replay)
  // must stay a fail-closed identity violation so the same turn can never be counted twice.
  const duplicatedUuid = lastUuid(logText);
  const compacted = [
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY'),
    { type: 'user', uuid: duplicatedUuid, parentUuid: 'compact-1-summary', message: { role: 'user', content: 'replayed prompt' } },
    {
      type: 'assistant', uuid: 'replayed-assistant', parentUuid: duplicatedUuid,
      message: { id: 'replayed-message', role: 'assistant', content: [{ type: 'text', text: 'REPLAYED-ANSWER' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'replayed-completion',
      parentUuid: 'replayed-assistant', durationMs: 1,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  rejects(() => extractClaudeNativeTurns(`${logText}\n${compacted}\n`));
});

test('Claude reader drops an interrupted turn inside a compacted segment and keeps the following completed turn', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  // A caller user before the pending turn's completion record marks the pending turn as interrupted
  // (user resubmitted before turn_duration): it is dropped, never promoted, and reading continues.
  const compacted = [
    ...claudeCompactionBoundaryRecords('compact-1', 'COMPACT-SUMMARY'),
    {
      type: 'user', uuid: 'interrupted-user', parentUuid: 'compact-1-summary',
      message: { role: 'user', content: 'INTERRUPTED-PROMPT' },
    },
    {
      type: 'assistant', uuid: 'interrupted-assistant', parentUuid: 'interrupted-user',
      message: { id: 'interrupted-message', role: 'assistant', content: [{ type: 'text', text: 'INTERRUPTED-PARTIAL-ANSWER' }] },
    },
    { type: 'user', uuid: 'following-user', parentUuid: 'interrupted-assistant', message: { role: 'user', content: 'second' } },
    {
      type: 'assistant', uuid: 'following-assistant', parentUuid: 'following-user',
      message: { id: 'following-message', role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'following-completion',
      parentUuid: 'following-assistant', durationMs: 10,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${compacted}\n`);
  assert.equal(turns.length, 3);
  assert.equal(turns[2]!.userText, 'second');
  assert.equal(turns[2]!.assistantText, 'answer 2');
  assert.deepEqual(turns[2]!.nativeIds, {
    userId: 'following-user',
    assistantIds: ['following-message'],
    completionId: 'following-completion',
  });
  const serialized = JSON.stringify(turns);
  assert.ok(!serialized.includes('INTERRUPTED-PROMPT'), 'interrupted caller text must never be emitted');
  assert.ok(!serialized.includes('INTERRUPTED-PARTIAL-ANSWER'), 'partial assistant text of an interrupted turn must never be emitted');
  assert.ok(!serialized.includes('COMPACT-SUMMARY'), 'the compaction summary must never be emitted');
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

test('Claude reader drops an interrupted turn and continues from the next caller user', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const parent = lastUuid(logText);
  const interrupted = [
    {
      type: 'user', uuid: 'interrupted-user', parentUuid: parent,
      message: { role: 'user', content: 'INTERRUPTED-PROMPT' },
    },
    {
      type: 'assistant', uuid: 'interrupted-assistant', parentUuid: 'interrupted-user',
      message: { id: 'interrupted-message', role: 'assistant', content: [{ type: 'text', text: 'INTERRUPTED-PARTIAL-ANSWER' }] },
    },
    {
      type: 'user', uuid: 'following-user', parentUuid: 'interrupted-assistant',
      message: { role: 'user', content: 'second prompt' },
    },
    {
      type: 'assistant', uuid: 'following-assistant', parentUuid: 'following-user',
      message: { id: 'following-message', role: 'assistant', content: [{ type: 'text', text: 'SECOND-ANSWER' }] },
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: 'following-completion',
      parentUuid: 'following-assistant', durationMs: 10,
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  const turns = extractClaudeNativeTurns(`${logText}\n${interrupted}\n`);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((turn) => turn.assistantText), ['REMEMBERED', 'BLUEFIN-7', 'SECOND-ANSWER']);
  assert.equal(turns[2]!.userText, 'second prompt');
  assert.deepEqual(turns[2]!.nativeIds, {
    userId: 'following-user',
    assistantIds: ['following-message'],
    completionId: 'following-completion',
  });
  assert.ok(!JSON.stringify(turns).includes('INTERRUPTED-'), 'interrupted turn text must never be emitted');
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

  // Removing the final task_complete leaves a trailing open window that ends on an assistant
  // message; exec rollouts omit that completion, so the reader recovers the turn.
  const withoutLastCompletion = lines(logText)
    .map((line) => JSON.parse(line))
    .filter((entry) => !(entry.type === 'event_msg' && entry.payload?.type === 'task_complete' &&
      entry.payload.turn_id === turns[1]!.nativeIds.completionId))
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  const recoveredTrailing = extractCodexNativeTurns(`${withoutLastCompletion}\n`);
  assert.equal(recoveredTrailing.length, 2);
  assert.equal(recoveredTrailing[1]!.assistantText, 'BLUEFIN-7');
  assert.equal(recoveredTrailing[1]!.nativeIds.completionId, turns[1]!.nativeIds.completionId);
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
  wrongIdentity.find((entry) => entry.type === 'session_meta')!.payload.id = 'foreign-session';
  rejects(() => assertCodexNativeSessionIdentity(
    wrongIdentity.map((entry) => JSON.stringify(entry)).join('\n'),
    expectedSessionId,
  ));

  // exec resume/fork rewrites replay parent session_meta records after the file's own first meta;
  // later metas are not identity-checked.
  const duplicateMetadata = `${logText.trimEnd()}\n${JSON.stringify(sessionMeta)}\n`;
  assert.doesNotThrow(() => assertCodexNativeSessionIdentity(duplicateMetadata, expectedSessionId));
});

test('Codex reader skips compaction markers, drops orphan aborts, and fails closed on rollback', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  assert.equal(extractCodexNativeTurns(`${logText}\n${JSON.stringify({ type: 'compacted' })}\n`).length, 2);
  assert.equal(extractCodexNativeTurns(`${logText}\n${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  })}\n`).length, 2);
  // turn_aborted without task_started closes an implicit window: the aborted turn is dropped and
  // the completed turns stay portable.
  assert.equal(extractCodexNativeTurns(`${logText}\n${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'turn_aborted', turn_id: 'orphan-abort' },
  })}\n`).length, 2);
  rejects(() => extractCodexNativeTurns(`${logText}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } })}\n`));
  rejects(() => extractCodexNativeTurns(`${logText}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'thread_rolled_back' } })}\n`));
});

test('Codex reader closes a window missing task_complete at the next task_started', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  const turns = extractCodexNativeTurns(logText);
  const withoutFirstCompletion = lines(logText)
    .map((line) => JSON.parse(line))
    .filter((entry) => !(entry.type === 'event_msg' && entry.payload?.type === 'task_complete' &&
      entry.payload.turn_id === turns[0]!.nativeIds.completionId))
    .map((entry) => JSON.stringify(entry))
    .join('\n');

  const recovered = extractCodexNativeTurns(`${withoutFirstCompletion}\n`);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0]!.assistantText, 'REMEMBERED');
  assert.equal(recovered[0]!.nativeIds.completionId, turns[0]!.nativeIds.completionId);
  assert.equal(recovered[1]!.assistantText, 'BLUEFIN-7');
  assert.equal(recovered[1]!.nativeIds.completionId, turns[1]!.nativeIds.completionId);
});

test('Codex reader skips completed lifecycle windows without portable messages', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  const structureless = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'completed-without-messages' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'completed-without-messages' } },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  assert.equal(extractCodexNativeTurns(`${logText}\n${structureless}\n`).length, 2);
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
  // Real callers always carry the adjacent user_message mirror; without it the reader treats the
  // record as injected content.
  const userMirror = { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } };
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
    started, unrelated, user, userMirror, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')).length, 1);
  rejects(() => extractCodexNativeTurns([
    started, user, userMirror, assistant, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started,
    user,
    userMirror,
    { ...assistantWithId, payload: { ...assistantWithId.payload, id: 'turn-a' } },
    complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    complete, started, user, userMirror, assistantWithId,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, assistantWithId, user, userMirror, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, user, userMirror, complete, assistantWithId,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  // exec resume rewrites can replay passthrough content before the turn's own task_started; the
  // content accumulates into the same pending turn.
  assert.equal(extractCodexNativeTurns([
    user, userMirror, started, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')).length, 1);
  rejects(() => extractCodexNativeTurns([
    started, started, user, userMirror, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, user, userMirror, assistantWithId, complete, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')));
  rejects(() => extractCodexNativeTurns([
    started, user, userMirror, assistantWithId, complete, assistantWithId,
  ].map((entry) => JSON.stringify(entry)).join('\n')));

  const startedB = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } };
  const userB = {
    ...user,
    payload: {
      ...user.payload,
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
    },
  };
  const userMirrorB = { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } };
  const assistantB = {
    ...assistantWithId,
    payload: {
      ...assistantWithId.payload,
      id: 'assistant-message-b',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
    },
  };
  const completeB = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } };
  // Parallel windows are legal: exec resume rewrites nest one turn's window inside another, and
  // passthrough binding keeps each record on its own turn.
  const interleaved = extractCodexNativeTurns([
    started, user, userMirror, startedB, userB, userMirrorB, assistantWithId, complete, assistantB, completeB,
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  assert.equal(interleaved.length, 2);
  assert.deepEqual(
    interleaved.map((turn) => turn.nativeIds.completionId),
    ['turn-a', 'turn-b'],
  );

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
    started, ...excludedForeignMessages, user, userMirror, assistantWithId, complete,
  ].map((entry) => JSON.stringify(entry)).join('\n')).length, 1);
});

const CODEX_OLDFORMAT_SESSION_META = {
  type: 'session_meta',
  payload: { id: '019e0000-0000-7000-8000-000000000001', cli_version: '0.134.0', originator: 'codex_exec', source: 'exec' },
};

function codexOldFormatTurn(turnId: string, prompt: string, answers: readonly [string, string]) {
  return {
    started: { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    developerContext: {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'synthetic developer preamble' },
          { type: 'input_text', text: 'synthetic developer rules' },
        ],
      },
    },
    injectedInstructions: {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'synthetic caller instructions' },
          { type: 'input_text', text: 'synthetic environment context' },
        ],
      },
    },
    turnContext: { type: 'turn_context', payload: { turn_id: turnId, cwd: '/synthetic' } },
    callerUser: {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    },
    callerMirror: { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    reasoning: {
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'synthetic-opaque' },
    },
    agentMessage: { type: 'event_msg', payload: { type: 'agent_message', message: answers[0], phase: 'commentary' } },
    answerOne: {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answers[0] }], phase: 'commentary' },
    },
    functionCall: {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'call_oldformat_1' },
    },
    functionCallOutput: {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_oldformat_1', output: 'ok' },
    },
    answerTwo: {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answers[1] }], phase: 'final_answer' },
    },
    tokenCount: { type: 'event_msg', payload: { type: 'token_count' } },
    complete: { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  };
}

function codexOldFormatTurnRecords(turn: ReturnType<typeof codexOldFormatTurn>): object[] {
  return [
    turn.started, turn.developerContext, turn.injectedInstructions, turn.turnContext,
    turn.callerUser, turn.callerMirror, turn.reasoning, turn.agentMessage, turn.answerOne,
    turn.functionCall, turn.functionCallOutput, turn.answerTwo, turn.tokenCount, turn.complete,
  ];
}

function codexMirrorCallerRecords(prompt: string): object[] {
  return [
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
  ];
}

function codexWindowBoundAssistantRecord(answer: string): object {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] },
  };
}

function codexPassthroughTurnRecords(turnId: string, prompt: string, answer: string, assistantId: string): object[] {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    // Real passthrough-generation callers always carry this adjacent mirror; it is the caller
    // evidence the reader requires in both record generations.
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id: assistantId,
        content: [{ type: 'output_text', text: answer }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];
}

test('Codex reader binds window-bound old-format records and synthesizes native ids', () => {
  const turn = codexOldFormatTurn('T1', 'PROMPT-A', ['ANS-1', 'ANS-2']);
  const turns = extractCodexNativeTurns(
    [CODEX_OLDFORMAT_SESSION_META, ...codexOldFormatTurnRecords(turn)]
      .map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'PROMPT-A');
  assert.equal(turns[0]!.assistantText, 'ANS-1\n\nANS-2');
  assert.deepEqual(turns[0]!.nativeIds, {
    userId: 'user:T1',
    assistantIds: ['assistant:T1:1', 'assistant:T1:2'],
    completionId: 'T1',
  });
});

test('Codex reader ignores in-window single-block user records without an adjacent mirror', () => {
  const turn = codexOldFormatTurn('T1', 'PROMPT-A', ['ANS-1', 'ANS-2']);
  const injectedNotice = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<turn_aborted>synthetic aborted-turn notice</turn_aborted>' }],
    },
  };
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      turn.started, turn.callerUser, turn.callerMirror, turn.answerOne,
      injectedNotice, turn.functionCall, turn.functionCallOutput,
      turn.answerTwo, turn.complete,
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'PROMPT-A');
  assert.equal(turns[0]!.assistantText, 'ANS-1\n\nANS-2');
});

test('Codex reader ignores passthrough-bound injected user records without an adjacent mirror', () => {
  // New-format (passthrough-bound) window: an <environment_context>-style injection carries the
  // same passthrough turn_id as the caller but has no user_message mirror, so passthrough alone
  // must never qualify a caller. Only the mirrored user is the caller and the window is one turn.
  const sessionMeta = {
    type: 'session_meta',
    payload: { id: '019e0000-0000-7000-8000-000000000002', cli_version: '0.142.5', originator: 'codex_exec', source: 'exec' },
  };
  const injectedEnvironmentContext = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>synthetic environment</environment_context>' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
    },
  };
  const callerUser = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Q1' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
    },
  };
  const turns = extractCodexNativeTurns(
    [
      sessionMeta,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
      injectedEnvironmentContext,
      callerUser,
      { type: 'event_msg', payload: { type: 'user_message', message: 'Q1' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'msg_injection_regression_a',
          content: [{ type: 'output_text', text: 'A1' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q1');
  assert.equal(turns[0]!.assistantText, 'A1');
  assert.deepEqual(turns[0]!.nativeIds, {
    userId: 'user:T1',
    assistantIds: ['msg_injection_regression_a'],
    completionId: 'T1',
  });
});

test('Codex reader rejects a mirrored caller message outside a task lifecycle window', () => {
  const turn = codexOldFormatTurn('T1', 'PROMPT-A', ['ANS-1', 'ANS-2']);
  rejects(() => extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      turn.callerUser, turn.callerMirror,
      ...codexPassthroughTurnRecords('T2', 'PROMPT-B', 'ANS-3', 'msg_newformat_a'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  ));
});

test('Codex reader rejects window-bound assistant text outside a task lifecycle window', () => {
  const turn = codexOldFormatTurn('T1', 'PROMPT-A', ['ANS-1', 'ANS-2']);
  rejects(() => extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      turn.answerOne,
      ...codexPassthroughTurnRecords('T2', 'PROMPT-B', 'ANS-3', 'msg_newformat_b'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  ));
});

test('Codex reader merges adjacent mid-turn steering caller messages inside one lifecycle window', () => {
  const turn = codexOldFormatTurn('T1', 'PROMPT-A', ['ANS-1', 'ANS-2']);
  const secondCaller = codexOldFormatTurn('T1', 'PROMPT-A2', ['ANS-1', 'ANS-2']);
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      turn.started, turn.callerUser, turn.callerMirror,
      secondCaller.callerUser, secondCaller.callerMirror,
      turn.answerOne, turn.answerTwo, turn.complete,
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'PROMPT-A\n\nPROMPT-A2');
  assert.equal(turns[0]!.assistantText, 'ANS-1\n\nANS-2');
  assert.equal(turns[0]!.nativeIds.userId, 'user:T1');
});

test('Codex reader extracts mixed-generation rollouts with per-record binding', () => {
  const oldTurn = codexOldFormatTurn('T1', 'PROMPT-A', ['ANS-1', 'ANS-2']);
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      ...codexOldFormatTurnRecords(oldTurn),
      ...codexPassthroughTurnRecords('T2', 'PROMPT-B', 'ANS-3', 'msg_newformat_c'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.userText, 'PROMPT-A');
  assert.deepEqual(turns[0]!.nativeIds, {
    userId: 'user:T1',
    assistantIds: ['assistant:T1:1', 'assistant:T1:2'],
    completionId: 'T1',
  });
  assert.equal(turns[1]!.userText, 'PROMPT-B');
  assert.equal(turns[1]!.assistantText, 'ANS-3');
  assert.deepEqual(turns[1]!.nativeIds, {
    userId: 'user:T2',
    assistantIds: ['msg_newformat_c'],
    completionId: 'T2',
  });
});

test('Codex reader completes a task_complete-omitting turn at the next task_started', () => {
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
      ...codexMirrorCallerRecords('Q1'),
      codexWindowBoundAssistantRecord('A1'),
      ...codexPassthroughTurnRecords('T2', 'Q2', 'A2', 'msg_completion_model_a'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.userText, 'Q1');
  assert.equal(turns[0]!.assistantText, 'A1');
  assert.deepEqual(turns[0]!.nativeIds, {
    userId: 'user:T1',
    assistantIds: ['assistant:T1:1'],
    completionId: 'T1',
  });
  assert.equal(turns[1]!.userText, 'Q2');
  assert.equal(turns[1]!.assistantText, 'A2');
  assert.equal(turns[1]!.nativeIds.completionId, 'T2');
});

test('Codex reader recovers original turns around compaction without reading replacement_history', () => {
  const compacted = {
    type: 'compacted',
    payload: {
      replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SUMMARY-USER' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SUMMARY-ASSISTANT' }] },
      ],
    },
  };
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      ...codexPassthroughTurnRecords('T1', 'Q1', 'A1', 'msg_compact_a'),
      compacted,
      { type: 'event_msg', payload: { type: 'context_compacted' } },
      ...codexPassthroughTurnRecords('T2', 'Q2', 'A2', 'msg_compact_b'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => [turn.userText, turn.assistantText]),
    [['Q1', 'A1'], ['Q2', 'A2']],
  );
  assert.ok(!JSON.stringify(turns).includes('SUMMARY-'));
});

test('Codex reader drops turn_aborted windows and keeps later completed turns', () => {
  const abortedWindow = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    ...codexMirrorCallerRecords('Q1'),
    codexWindowBoundAssistantRecord('partial'),
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'T1', reason: 'user_interrupt' } },
  ];
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      ...abortedWindow,
      ...codexPassthroughTurnRecords('T2', 'Q2', 'A2', 'msg_abort_a'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q2');
  assert.equal(turns[0]!.assistantText, 'A2');
  assert.equal(turns[0]!.nativeIds.completionId, 'T2');

  rejects(() => extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      ...abortedWindow,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  ));
});

test('Codex reader fails closed on thread_rolled_back', () => {
  rejects(() => extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      ...codexPassthroughTurnRecords('T1', 'Q1', 'A1', 'msg_rollback_a'),
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  ));
});

test('Codex reader skips lifecycle windows without a caller user message', () => {
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T0' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'developer-only context' }],
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T0' } },
      ...codexPassthroughTurnRecords('T2', 'Q2', 'A2', 'msg_skip_a'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q2');
  assert.equal(turns[0]!.nativeIds.completionId, 'T2');
});

test('Codex reader treats a foreign task_complete as an implicit window and recovers the open turn', () => {
  // task_complete no longer needs to own the innermost window: a completion for an unseen turn id
  // settles that (content-free) implicit window, and the still-open trailing window that ends on
  // an assistant message is recovered.
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
      ...codexMirrorCallerRecords('Q1'),
      codexWindowBoundAssistantRecord('A1'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T-other' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q1');
  assert.equal(turns[0]!.assistantText, 'A1');
  assert.equal(turns[0]!.nativeIds.completionId, 'T1');
});

test('Codex reader fails closed when the completion boundary id collides with an assistant id', () => {
  rejects(() => extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Q1' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
        },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Q1' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'T1',
          content: [{ type: 'output_text', text: 'A1' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  ));
});

test('Codex reader recovers the implicit first exec window completed without task_started', () => {
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Q1' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
        },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Q1' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'msg_implicit_first_a',
          content: [{ type: 'output_text', text: 'A1' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q1');
  assert.equal(turns[0]!.assistantText, 'A1');
  assert.deepEqual(turns[0]!.nativeIds, {
    userId: 'user:T1',
    assistantIds: ['msg_implicit_first_a'],
    completionId: 'T1',
  });
});

test('Codex reader recovers a trailing open window that ends on an assistant message', () => {
  const turn = codexOldFormatTurn('T1', 'Q1', ['ANS-1', 'ANS-2']);
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      turn.started, turn.callerUser, turn.callerMirror,
      turn.reasoning, turn.agentMessage, turn.answerOne,
      turn.functionCall, turn.functionCallOutput, turn.answerTwo,
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q1');
  assert.equal(turns[0]!.assistantText, 'ANS-1\n\nANS-2');
  assert.deepEqual(turns[0]!.nativeIds, {
    userId: 'user:T1',
    assistantIds: ['assistant:T1:1', 'assistant:T1:2'],
    completionId: 'T1',
  });
});

test('Codex reader drops a trailing open window cut off mid-work without failing', () => {
  const turn = codexOldFormatTurn('T1', 'Q1', ['ANS-1', 'ANS-2']);
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      turn.started, turn.callerUser, turn.callerMirror,
      turn.answerOne, turn.functionCall,
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.deepEqual(turns, []);
});

test('Codex reader recovers nested parallel windows in exec resume rewrites', () => {
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'TA' } },
      ...codexMirrorCallerRecords('QA'),
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'TB' } },
      ...codexMirrorCallerRecords('QB'),
      codexWindowBoundAssistantRecord('AB'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'TB' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'msg_nested_outer_a',
          content: [{ type: 'output_text', text: 'AA' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'TA' },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'TA' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => [turn.userText, turn.assistantText, turn.nativeIds.completionId]),
    [['QA', 'AA', 'TA'], ['QB', 'AB', 'TB']],
  );
});

test('Codex reader completes an omitted-complete window at a successor task_started', () => {
  // The successor rule settles the window even when its tail is a tool call, where the trailing
  // assistant-tail rule alone would drop it.
  const turn = codexOldFormatTurn('TA', 'QA', ['AA', 'unused']);
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      turn.started, turn.callerUser, turn.callerMirror,
      turn.answerOne, turn.functionCall,
      ...codexPassthroughTurnRecords('TB', 'QB', 'AB', 'msg_successor_b'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((item) => [item.userText, item.assistantText, item.nativeIds.completionId]),
    [['QA', 'AA', 'TA'], ['QB', 'AB', 'TB']],
  );
});

test('Codex reader merges interleaved steering callers in record order', () => {
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
      ...codexMirrorCallerRecords('u1'),
      codexWindowBoundAssistantRecord('a1'),
      ...codexMirrorCallerRecords('u2'),
      codexWindowBoundAssistantRecord('a2'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'u1\n\nu2');
  assert.equal(turns[0]!.assistantText, 'a1\n\na2');
  assert.equal(turns[0]!.nativeIds.userId, 'user:T1');
});

test('Codex reader fails closed on portable messages after explicit task_complete', () => {
  const base = [
    CODEX_OLDFORMAT_SESSION_META,
    ...codexPassthroughTurnRecords('T1', 'Q1', 'A1', 'msg_postcomplete_a'),
  ];
  rejects(() => extractCodexNativeTurns(
    [
      ...base,
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'msg_postcomplete_late',
          content: [{ type: 'output_text', text: 'late answer' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
        },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  ));
  rejects(() => extractCodexNativeTurns(
    [
      ...base,
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'late question' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'T1' },
        },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'late question' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  ));
});

test('Codex identity binds only the first session_meta record', () => {
  const fileId = '019f0000-0000-7000-8000-00000000aaaa';
  const parentId = '019f0000-0000-7000-8000-00000000bbbb';
  const fileMeta = { type: 'session_meta', payload: { id: fileId, session_id: fileId } };
  const parentMeta = { type: 'session_meta', payload: { id: parentId, session_id: parentId } };
  assert.doesNotThrow(() => assertCodexNativeSessionIdentity(
    [fileMeta, parentMeta].map((entry) => JSON.stringify(entry)).join('\n'),
    fileId,
  ));
  rejects(() => assertCodexNativeSessionIdentity(
    [parentMeta, fileMeta].map((entry) => JSON.stringify(entry)).join('\n'),
    fileId,
  ));
  rejects(() => assertCodexNativeSessionIdentity(
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    fileId,
  ));
});

test('Codex identity treats payload.id as authoritative and session_id as lineage metadata', () => {
  const fileId = '019f0000-0000-7000-8000-00000000cccc';
  const lineageRootId = '019f0000-0000-7000-8000-00000000dddd';
  // 0.142.0+ resume/fork rollouts: session_id carries the thread-lineage root, not this rollout's
  // identity (census 474/3,438 files with session_id != id).
  assert.doesNotThrow(() => assertCodexNativeSessionIdentity(
    JSON.stringify({ type: 'session_meta', payload: { id: fileId, session_id: lineageRootId } }),
    fileId,
  ));
  // payload.id stays authoritative: a lineage session_id matching the request never rescues a
  // foreign id.
  rejects(() => assertCodexNativeSessionIdentity(
    JSON.stringify({ type: 'session_meta', payload: { id: lineageRootId, session_id: fileId } }),
    fileId,
  ));
  // Legacy shape without payload.id falls back to session_id as the identity.
  assert.doesNotThrow(() => assertCodexNativeSessionIdentity(
    JSON.stringify({ type: 'session_meta', payload: { session_id: fileId } }),
    fileId,
  ));
});

test('Codex reader ignores thread_settings_applied after task_complete', () => {
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      ...codexPassthroughTurnRecords('T1', 'Q1', 'A1', 'msg_settings_a'),
      { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'synthetic' } } },
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q1');
  assert.equal(turns[0]!.assistantText, 'A1');
});

test('Codex reader never leaks content from a turn_aborted window', () => {
  const turns = extractCodexNativeTurns(
    [
      CODEX_OLDFORMAT_SESSION_META,
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'TA' } },
      ...codexMirrorCallerRecords('ABORTED-QUESTION'),
      codexWindowBoundAssistantRecord('ABORTED-ANSWER'),
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'TA', reason: 'user_interrupt' } },
      ...codexPassthroughTurnRecords('TB', 'Q2', 'A2', 'msg_noleak_b'),
    ].map((entry) => JSON.stringify(entry)).join('\n'),
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.userText, 'Q2');
  assert.equal(turns[0]!.assistantText, 'A2');
  assert.ok(!JSON.stringify(turns).includes('ABORTED-'));
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

test('Kiro reader rejects companion drift and mid-history unproven prompts', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const rawCompanionText = await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8');
  const companionText = validKiroCompanion(logText, rawCompanionText);
  // Companion metadata referencing message ids absent from the JSONL stays fail-closed.
  rejects(() => extractKiroNativeTurns(logText, rawCompanionText));
  // An unproven caller prompt at or before the proven boundary is a mid-history hole.
  const logLines = lines(logText);
  const midHistoryUnproven = [
    ...logLines.slice(0, 2),
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: {
        message_id: 'unproven-prompt',
        content: [{ kind: 'text', data: 'not in companion' }],
        meta: { timestamp: 1 },
      },
    }),
    ...logLines.slice(2),
  ].join('\n');
  rejects(() => extractKiroNativeTurns(`${midHistoryUnproven}\n`, companionText));
});

test('Kiro reader skips compaction records and allows the unproven trailing turn', async () => {
  // Mirrors the observed compacted session shape from live kiro evidence: proven turns stay intact
  // in the JSONL, Compaction fires mid trailing turn, and the trailing turn has no companion
  // metadata yet.
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
  const summarySentinel = 'COMPACTION_SUMMARY_SENTINEL';
  const snapshotSentinel = 'COMPACTION_SNAPSHOT_SENTINEL';
  const trailingSentinel = 'TRAILING_TURN_SENTINEL';
  const compactedLog = [
    ...lines(logText),
    // Third proven turn (already present in the golden companion metadata).
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: {
        message_id: '00000000-0000-4000-8000-000000000029',
        content: [{ kind: 'text', data: 'Reply with exactly: CONTROL_OK' }],
        meta: { timestamp: 1784008020 },
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        message_id: '00000000-0000-4000-8000-000000000033',
        content: [{ kind: 'text', data: 'CONTROL_OK' }],
      },
    }),
    // Unproven trailing turn with a Compaction record in its middle.
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: {
        message_id: 'trailing-turn-prompt',
        content: [{ kind: 'text', data: `${trailingSentinel} fourth turn in progress` }],
        meta: { timestamp: 1784008030 },
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'Compaction',
      data: {
        messages_snapshot: [{
          id: 'trailing-turn-prompt',
          role: 'user',
          content: [{ kind: 'text', data: snapshotSentinel }],
        }],
        strategy: { message_pairs_to_exclude: 2, truncate_large_messages: false },
        summary: `## OBJECTIVE\n${summarySentinel}`,
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        message_id: 'trailing-turn-assistant',
        content: [{ kind: 'text', data: `${trailingSentinel} still running` }],
      },
    }),
  ].join('\n');
  const turns = extractKiroNativeTurns(`${compactedLog}\n`, JSON.stringify(companion));
  assert.equal(turns.length, 3);
  assert.equal(turns[0]!.assistantText, 'REMEMBERED');
  assert.equal(turns[1]!.assistantText, 'BLUEFIN-7');
  assert.equal(turns[2]!.assistantText, 'CONTROL_OK');
  const portableText = turns.map((turn) => `${turn.userText}\n${turn.assistantText}`).join('\n');
  assert.ok(!portableText.includes(summarySentinel));
  assert.ok(!portableText.includes(snapshotSentinel));
  assert.ok(!portableText.includes(trailingSentinel));
});

test('Kiro reader keeps failing closed on unproven text assistant messages before the boundary', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companionText = validKiroCompanion(logText, await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
  const logLines = lines(logText);
  const midHistoryAssistant = [
    ...logLines.slice(0, 2),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        message_id: 'unproven-mid-history-assistant',
        content: [{ kind: 'text', data: 'not in companion' }],
      },
    }),
    ...logLines.slice(2),
  ].join('\n');
  rejects(() => extractKiroNativeTurns(`${midHistoryAssistant}\n`, companionText));
});

test('Kiro reader returns an empty turn list when no turn is proven by companion metadata', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  companion.session_state.conversation_metadata.user_turn_metadatas = [];
  // Zero proven turns puts the whole log after the proven boundary: trailing, not a violation.
  assert.deepEqual(extractKiroNativeTurns(logText, JSON.stringify(companion)), []);
});

test('Kiro append preflight accepts a compacted target session', async () => {
  const logText = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(validKiroCompanion(
    logText,
    await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'),
  ));
  const compactedLog = [
    ...lines(logText),
    JSON.stringify({
      version: 'v1',
      kind: 'Compaction',
      data: {
        messages_snapshot: [],
        strategy: { message_pairs_to_exclude: 2 },
        summary: 'compacted history summary',
      },
    }),
  ].join('\n');
  assertKiroNativeSessionAppendable(`${compactedLog}\n`, JSON.stringify(companion), companion.session_id);
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
  // Placed before the proven boundary: appended after it, this would be an allowed trailing record.
  const logLines = lines(logText);
  const midHistoryMixed = [...logLines.slice(0, 2), unprovenMixed, ...logLines.slice(2)].join('\n');
  rejects(() => extractKiroNativeTurns(`${midHistoryMixed}\n`, companionText));
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
