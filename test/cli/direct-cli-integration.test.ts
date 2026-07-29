import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenPStateRoot } from '../../src/core/state-root.js';
import { SessionStateStore } from '../../src/core/session-state.js';
import { createSeedAppendJournal } from '../../src/core/seed-append-journal.js';
import { digestNativeState } from '../../src/core/native-state-digest.js';
import { contentDigest } from '../../src/core/seed-ir.js';
import { externalSourceRefs } from '../../src/core/seed-provenance.js';
import type { NativeSessionReadResult, NativeTurnIds, NativeWrittenTurn } from '../../src/core/backend.js';
import {
  DIRECT_CLI_TEST_SESSION_ID,
  assertNativeOpenPOnlyStdout,
  assertNoTopLevelResultFormEvents,
  parseOutputLine,
  readDebugEntries,
  resultAnswerText,
  resultReasoningTexts,
  resultWarnings,
  runCommand,
  streamingAnswerTexts,
  streamingOutputKeys,
  streamingReasoningTexts,
  terminalOpenPResult,
  terminalResultAnswer,
} from '../helpers/cli-integration.js';

test('direct CLI keeps result and logs non-result-compatible streaming snapshot', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-mismatch',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);

  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(streamingTexts, ['working draft']);
  assert.equal(resultAnswerText(terminalResult), 'done');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
  assert.notEqual(
    await new SessionStateStore(
      projectRoot,
      resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    ).load(DIRECT_CLI_TEST_SESSION_ID),
    null,
  );
});

test('direct CLI resume settles a pending v2 marker before backend turn save', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const resolvedStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const stateStore = new SessionStateStore(projectRoot, resolvedStateRoot);
  const restoreState = await stateStore.save({
    backend: 'test-direct-cli',
    backendSessionId: DIRECT_CLI_TEST_SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'before-seed',
  });
  await stateStore.publishPendingSeedAppendMarker({
    restoreState,
    seedAppendJournal: directCliPendingJournal(),
  });

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--resume',
    DIRECT_CLI_TEST_SESSION_ID,
    'hello',
  ], projectRoot, {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-mismatch',
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'done\n');
  assert.equal(await stateStore.loadPendingSeedAppendMarker(DIRECT_CLI_TEST_SESSION_ID), null);
  const restored = await stateStore.load(DIRECT_CLI_TEST_SESSION_ID);
  assert.equal(restored?.schemaVersion, 1);
  assert.equal(restored?.backend, 'test-direct-cli');
  assert.equal(restored?.backendSessionId, DIRECT_CLI_TEST_SESSION_ID);
  assert.notEqual(restored?.lastTurnId, 'before-seed');
});

test('direct CLI does not surface streaming-result diagnostic diagnostics without debug log', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-mismatch',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(terminalResultAnswer(events), 'done');
});

test('verbose direct CLI reports unrecorded streaming result diagnostics without claiming a debug log', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-mismatch',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--verbose',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(resultWarnings(terminalResult), [{
    severity: 'warning',
    code: 'streaming_result_diagnostic',
    message: 'Streaming result diagnostics were detected (1); result was preserved. Use --debug-log to record details.',
  }]);
  await assert.rejects(
    () => stat(debugLogPath),
    (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );
});

test('direct CLI appends verbose marker to successful text output', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-mismatch',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    '--verbose',
    'test-direct-cli',
    '--output-format',
    'text',
    'hello',
  ], projectRoot, env);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    'done',
    '[openp verbose] enabled',
    '',
  ].join('\n'));
});

test('direct CLI keeps result and logs replacement intermediate text outside result', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-replacement-before-result',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(streamingTexts, ['first progress', 'first progress\n\nsecond progress']);
  assert.equal(resultAnswerText(terminalResult), 'result answer');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
});

test('direct CLI accumulates assistant snapshot text before result', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'assistant-snapshot-replacement-before-result',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(streamingTexts, ['first progress', 'first progress\n\nsecond progress']);
  assert.equal(resultAnswerText(terminalResult), 'result answer');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
});

test('direct CLI emits reasoning before answer for mixed assistant snapshots', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'assistant-snapshot-reasoning-and-text',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(streamingOutputKeys(events), [
    'reasoning',
    'answer',
  ]);
  assert.deepEqual(streamingReasoningTexts(events), ['thinking']);
  assert.deepEqual(streamingAnswerTexts(events), ['answer']);
  assert.equal(terminalResultAnswer(events), 'answer');
});

test('direct CLI keeps background assistant snapshots out of active streaming and result', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'background-assistant-snapshot',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const openpEvents = events.map((event) => event.openp);
  const activeStreamingAnswers = openpEvents
    .filter((openp) => openp.form === 'streaming' && openp.scope === 'active')
    .map((openp) => openp.output?.answer)
    .filter((text): text is string => typeof text === 'string');
  const backgroundStreaming = openpEvents.find((openp) => openp.form === 'streaming' && openp.scope === 'background');
  const terminal = openpEvents.at(-1);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(activeStreamingAnswers, []);
  assert.deepEqual(backgroundStreaming?.output, { answer: 'background done' });
  assert.equal(terminal?.form, 'result');
  assert.deepEqual(terminal?.output?.answer, ['active result']);
  assert.deepEqual(terminal?.output?.toolCall, []);
  assert.deepEqual(terminal?.output?.toolResult, []);
});

test('direct CLI does not backfill result answer tail into streaming snapshot', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-prefix-result-tail',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(streamingTexts, ['A', 'AB']);
  assert.equal(resultAnswerText(terminalResult), 'ABC');
});

test('direct CLI stream-json stdout is openp-only without legacy or substring update fields', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-prefix-result-tail',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assertNativeOpenPOnlyStdout(result.stdout);
  const openpEvents = result.stdout.trimEnd().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).openp);
  assert.deepEqual(openpEvents
    .filter((event) => event.form === 'streaming' && typeof event.output?.answer === 'string')
    .map((event) => event.output.answer), ['A', 'AB']);
  const turnResult = openpEvents.find((event) => event.form === 'result');
  assert.deepEqual(turnResult?.output?.answer, ['ABC']);
});

test('direct CLI keeps result and logs streamed reasoning/text when text streaming snapshot is outside result', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'reasoning-before-text-replacement',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const reasoningSnapshots = streamingReasoningTexts(events);
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(reasoningSnapshots, ['thinking']);
  assert.deepEqual(streamingTexts, ['draft', 'draft\n\nanswer']);
  assert.equal(resultAnswerText(terminalResult), 'answer');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
});

test('direct CLI keeps result and logs streamed reasoning outside result reasoning', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'reasoning-mismatch',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);

  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(resultAnswerText(terminalResult), 'done');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-reasoning-outside-result');
  assert.equal(streamingReasoningTexts(events).length > 0, true);
  assert.notEqual(
    await new SessionStateStore(
      projectRoot,
      resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    ).load(DIRECT_CLI_TEST_SESSION_ID),
    null,
  );
});

test('direct CLI keeps result and logs streaming reasoning replacement', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'streaming-reasoning-replacement',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const reasoningSnapshots = streamingReasoningTexts(events);
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(reasoningSnapshots, ['first draft', 'first draft\n\nreplacement']);
  assert.deepEqual(streamingTexts, ['done']);
  assert.deepEqual(resultReasoningTexts(terminalResult), ['replacement']);
  assert.equal(resultAnswerText(terminalResult), 'done');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-reasoning-outside-result');
  assert.notEqual(
    await new SessionStateStore(
      projectRoot,
      resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    ).load(DIRECT_CLI_TEST_SESSION_ID),
    null,
  );
});

test('direct CLI emits live reasoning after answer text streaming starts', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'reasoning-tail-after-text',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const reasoningSnapshots = streamingReasoningTexts(events);
  const streamingTexts = streamingAnswerTexts(events);

  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(reasoningSnapshots, ['think', 'think\n\nlater reasoning']);
  assert.deepEqual(streamingTexts, ['answer']);
  assert.equal(resultAnswerText(terminalResult), 'answer');
  assert.notEqual(
    await new SessionStateStore(
      projectRoot,
      resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    ).load(DIRECT_CLI_TEST_SESSION_ID),
    null,
  );
});

test('direct CLI does not synthesize result-only reasoning into streaming output', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = {
    XDG_STATE_HOME: stateRoot,
    OPENP_TEST_DIRECT_CLI_SCENARIO: 'text-first-result-reasoning',
  };

  const result = await runCommand(tsxBin, [
    '--import',
    join(repoRoot, 'test', 'helpers', 'register-direct-cli-test-backend.ts'),
    join(repoRoot, 'src/cli.ts'),
    'test-direct-cli',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const reasoningSnapshots = streamingReasoningTexts(events);
  const streamingTexts = streamingAnswerTexts(events);

  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(reasoningSnapshots, []);
  assert.deepEqual(streamingTexts, ['answer']);
  assert.equal(resultAnswerText(terminalResult), 'answer');
  assert.notEqual(
    await new SessionStateStore(
      projectRoot,
      resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    ).load(DIRECT_CLI_TEST_SESSION_ID),
    null,
  );
});

function directCliIds(prefix: string): NativeTurnIds {
  return {
    userId: `${prefix}:user`,
    assistantIds: [`${prefix}:assistant`],
    completionId: `${prefix}:complete`,
  };
}

function directCliNativeDigest(turns: readonly unknown[]): string {
  return digestNativeState('direct-cli-pending-seed-test-v1', [Buffer.from(JSON.stringify(turns), 'utf8')]);
}

function directCliPendingJournal() {
  const beforeTurns: readonly [] = [];
  const before: NativeSessionReadResult = {
    backend: 'test-direct-cli',
    sessionId: DIRECT_CLI_TEST_SESSION_ID,
    turns: beforeTurns,
    nativeStateDigest: directCliNativeDigest(beforeTurns),
  };
  const written: readonly NativeWrittenTurn[] = [{
    logicalId: `ir:${'1'.repeat(64)}`,
    contentDigest: contentDigest('seed user', 'seed assistant'),
    nativeIds: directCliIds('written'),
  }];
  const fullTurns = [
    { userText: 'seed user', assistantText: 'seed assistant', nativeIds: directCliIds('written') },
  ];
  return createSeedAppendJournal({
    backend: 'test-direct-cli',
    sessionId: DIRECT_CLI_TEST_SESSION_ID,
    before,
    provenance: null,
    sourceRefs: externalSourceRefs('d'.repeat(64), ['direct-cli-external-id']),
    written,
    candidateNativeStateDigest: directCliNativeDigest(fullTurns),
  });
}
