import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { extractClaudeNativeTurns } from '../src/backends/claude/native-reader.js';
import { buildClaudeCodeHistoryEntries } from '../src/backends/claude/history-writer.js';
import { extractCodexNativeTurns } from '../src/backends/codex/native-reader.js';
import { buildCodexHistoryEntries } from '../src/backends/codex/history-writer.js';
import { extractKiroNativeTurns } from '../src/backends/kiro/native-reader.js';
import { buildKiroCompanionWithAppendedTurns, buildKiroHistoryEntries } from '../src/backends/kiro/history-writer.js';
import { extractOpenCodeNativeTurns } from '../src/backends/opencode/native-reader.js';
import { buildOpenCodeImport } from '../src/backends/opencode/history-writer.js';
import type { NativeSessionReadResult, NativeSessionTurn, NativeWrittenTurn, SeedWriteTurn } from '../src/core/backend.js';
import { logicalTurnsFromNative, toSeedWriteTurns } from '../src/core/seed-ir.js';

const FIXTURES = join(process.cwd(), 'test/fixtures/seed');

type BackendId = 'claude' | 'codex' | 'kiro' | 'opencode';

interface SourceFixture {
  readonly backend: BackendId;
  readonly sessionId: string;
  readonly turns: readonly SeedWriteTurn[];
}

interface TargetWriteResult {
  readonly written: readonly NativeWrittenTurn[];
  readonly readBack: readonly NativeSessionTurn[];
}

function lines(text: string): string[] {
  return text.trimEnd().split('\n').filter(Boolean);
}

function validKiroCompanion(logText: string, companionText: string): string {
  const logIds = new Set(lines(logText).map((line) => JSON.parse(line).data?.message_id).filter(Boolean));
  const companion = JSON.parse(companionText);
  companion.session_state.conversation_metadata.user_turn_metadatas =
    companion.session_state.conversation_metadata.user_turn_metadatas.filter((metadata: any) =>
      Array.isArray(metadata.message_ids) && metadata.message_ids.every((id: string) => logIds.has(id)),
    );
  return `${JSON.stringify(companion, null, 2)}\n`;
}

async function loadSources(): Promise<readonly SourceFixture[]> {
  const claudeLog = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
  const codexLog = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
  const kiroLog = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const kiroCompanion = validKiroCompanion(kiroLog, await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
  const opencodeExport = await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8');
  const reads: NativeSessionReadResult[] = [
    { backend: 'claude', sessionId: 'claude-source', turns: extractClaudeNativeTurns(claudeLog) },
    { backend: 'codex', sessionId: 'codex-source', turns: extractCodexNativeTurns(codexLog) },
    { backend: 'kiro', sessionId: 'kiro-source', turns: extractKiroNativeTurns(kiroLog, kiroCompanion) },
    { backend: 'opencode', sessionId: 'opencode-source', turns: extractOpenCodeNativeTurns(opencodeExport) },
  ];
  return reads.map((read) => ({
    backend: read.backend as BackendId,
    sessionId: read.sessionId,
    turns: toSeedWriteTurns(logicalTurnsFromNative(read)),
  }));
}

async function writeToTarget(target: BackendId, turns: readonly SeedWriteTurn[]): Promise<TargetWriteResult> {
  switch (target) {
    case 'claude': {
      const log = await readFile(join(FIXTURES, 'redacted-claude-golden.jsonl'), 'utf8');
      const result = buildClaudeCodeHistoryEntries(log, turns, Date.UTC(2026, 6, 14, 12, 0, 0));
      assert.equal(result.lines.length, turns.length * 3);
      const readBack = extractClaudeNativeTurns(`${log.trimEnd()}\n${result.lines.join('\n')}\n`);
      return { written: result.written, readBack };
    }
    case 'codex': {
      const log = await readFile(join(FIXTURES, 'redacted-codex-golden.jsonl'), 'utf8');
      const result = buildCodexHistoryEntries(log, turns, Date.UTC(2026, 6, 14, 12, 0, 0));
      assert.equal(result.lines.length, turns.length * 4);
      const readBack = extractCodexNativeTurns(`${log.trimEnd()}\n${result.lines.join('\n')}\n`);
      return { written: result.written, readBack };
    }
    case 'kiro': {
      const log = await readFile(join(FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
      const companion = validKiroCompanion(log, await readFile(join(FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
      const result = buildKiroHistoryEntries(log, turns, Math.floor(Date.UTC(2026, 6, 14, 12, 0, 0) / 1000));
      assert.equal(result.lines.length, turns.length * 2);
      const updatedCompanionText = buildKiroCompanionWithAppendedTurns(companion, turns, result.written);
      const updatedCompanion = JSON.parse(updatedCompanionText);
      const metadatas = updatedCompanion.session_state.conversation_metadata.user_turn_metadatas;
      assert.equal(metadatas.length >= turns.length, true);
      assert.deepEqual(
        metadatas.slice(-turns.length).map((metadata: any) => metadata.message_ids),
        result.written.map((turn) => [turn.nativeIds.userId, ...turn.nativeIds.assistantIds]),
      );
      const readBack = extractKiroNativeTurns(`${log.trimEnd()}\n${result.lines.join('\n')}\n`, updatedCompanionText);
      return { written: result.written, readBack };
    }
    case 'opencode': {
      const exportJson = await readFile(join(FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8');
      const result = buildOpenCodeImport(exportJson, turns, Date.UTC(2026, 6, 14, 12, 0, 0));
      const doc = JSON.parse(result.doc);
      assert.equal(doc.messages.length >= turns.length * 2, true);
      const readBack = extractOpenCodeNativeTurns(result.doc);
      return { written: result.written, readBack };
    }
  }
}

for (const source of ['claude', 'codex', 'kiro', 'opencode'] as const) {
  for (const target of ['claude', 'codex', 'kiro', 'opencode'] as const) {
    if (source === target) continue;
    test(`${source} reader IR writes to ${target} target writer`, async () => {
      const sources = await loadSources();
      const fixture = sources.find((item) => item.backend === source)!;
      assert.ok(fixture.turns.length > 0);
      const { written, readBack } = await writeToTarget(target, fixture.turns);
      assert.equal(written.length, fixture.turns.length);
      assert.deepEqual(written.map((turn) => turn.logicalId), fixture.turns.map((turn) => turn.logicalId));
      assert.deepEqual(written.map((turn) => turn.contentDigest), fixture.turns.map((turn) => turn.contentDigest));
      for (const turn of written) {
        assert.equal(turn.nativeIds.userId.length > 0, true);
        assert.equal(turn.nativeIds.assistantIds.length > 0, true);
        assert.equal(turn.nativeIds.completionId.length > 0, true);
      }
      const suffix = readBack.slice(-fixture.turns.length);
      assert.deepEqual(suffix.map((turn) => turn.userText), fixture.turns.map((turn) => turn.userText));
      assert.deepEqual(suffix.map((turn) => turn.assistantText), fixture.turns.map((turn) => turn.assistantText));
    });
  }
}
