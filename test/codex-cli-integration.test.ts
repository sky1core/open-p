import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import {
  CODEX_SESSION_ID,
  SESSION_ID,
  assertNoTopLevelResultFormEvents,
  collectChild,
  parseOutputLine,
  readDebugEntries,
  resultAnswerText,
  resultAnswerTexts,
  resultWarnings,
  runCommand,
  streamingAnswerTexts,
  terminalOpenPResult,
  waitForFile,
  withFakeCommandEnv,
  writeCodexCliSessionLog,
} from './helpers/cli-integration.js';

test('caller-selected first-turn session id is unsupported', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--session-id',
    SESSION_ID,
    'hello',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });

  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option: --session-id/);
});

test('codex first turn returns generated session id and resume uses that id', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-home-'));
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const argsLog = join(stateRoot, 'codex-args.log');
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-success.sh'), {
    XDG_STATE_HOME: stateRoot,
    CODEX_HOME: codexHome,
    OPENP_FAKE_CODEX_ARGS_LOG: argsLog,
  });

  const first = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'json',
    'hello',
  ], projectRoot, env);
  const firstEvent = parseOutputLine(first.stdout);

  assert.equal(first.code, 0);
  assert.equal(firstEvent.openp.sessionId, CODEX_SESSION_ID);
  await stat(join(workspaceStateRoot, 'sessions', `${CODEX_SESSION_ID}.json`));
  await writeCodexCliSessionLog(codexHome, CODEX_SESSION_ID);

  const resume = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--resume',
    CODEX_SESSION_ID,
    'follow up',
  ], projectRoot, env);

  assert.equal(resume.code, 0);
  assert.equal(resume.stdout, 'final answer here\n');
  assert.equal(resume.stderr, '');

  const argLines = (await readFile(argsLog, 'utf8')).trimEnd().split('\n');
  assert.match(argLines[0]!, /\texec\t/);
  assert.doesNotMatch(argLines[0]!, /\tresume\t/);
  assert.doesNotMatch(argLines[0]!, /dangerously-bypass-approvals-and-sandbox/);
  assert.match(argLines[1]!, new RegExp(`\\texec\\tresume\\t.*\\t${CODEX_SESSION_ID}\\tfollow up$`));
  assert.doesNotMatch(argLines[1]!, /dangerously-bypass-approvals-and-sandbox/);
});

test('codex stream-json first turn omits init session and returns generated result session id', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-success.sh'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'stream-json',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(events.map((event) => event.openp.form), ['result']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(events.at(-1)?.openp.sessionId, CODEX_SESSION_ID);
  await stat(join(workspaceStateRoot, 'sessions', `${CODEX_SESSION_ID}.json`));
});

test('codex stream-json without streaming opt-in emits only terminal turn result after backend completion', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const releaseFile = join(stateRoot, 'release-codex-turn');
  const readyFile = join(stateRoot, 'ready-codex-turn');
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-gated-stream.mjs'), {
    ...process.env,
    XDG_STATE_HOME: stateRoot,
    OPENP_FAKE_CODEX_RELEASE_FILE: releaseFile,
    OPENP_FAKE_CODEX_READY_FILE: readyFile,
  });
  const child = spawn(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'stream-json',
    'hello',
  ], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childResult = collectChild(child);
  const events: Record<string, any>[] = [];
  let stdoutBuffer = '';

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        events.push(parseOutputLine(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  try {
    await waitForFile(readyFile);
  } catch (error) {
    child.kill('SIGTERM');
    await childResult.catch(() => undefined);
    throw error;
  }

  assert.equal(events.some((event) => event.openp?.form === 'streaming'), false);
  assert.equal(events.some((event) => event.openp?.form === 'result'), false);
  await writeFile(releaseFile, 'go', 'utf8');
  const result = await childResult;

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const resultIndex = events.findIndex((event) => event.openp?.form === 'result');
  assertNoTopLevelResultFormEvents(events);
  assert.equal(events.some((event) => event.openp?.form === 'streaming'), false);
  assert.ok(resultIndex >= 0);
  assert.equal(events[resultIndex]?.openp.sessionId, CODEX_SESSION_ID);
  assert.equal(resultAnswerText(events[resultIndex]?.openp ?? {}), 'gated stream answer');
  assert.deepEqual(
    resultAnswerTexts(terminalOpenPResult(events)),
    ['gated stream answer'],
  );
});

test('codex streaming snapshot emits unphased agent messages as streaming answer outside result', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-item-progress-final.mjs'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(streamingTexts, [
    'checking sources',
    'checking sources\n\nsources checked',
    'checking sources\n\nsources checked\n\nfinal researched answer',
  ]);
  assert.equal(resultAnswerText(terminalResult), 'checking sources\n\nsources checked\n\nfinal researched answer');
  assert.equal(resultWarnings(terminalResult), undefined);
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
});

test('codex streaming snapshot uses stdout only when session log mirrors stdout', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-stdout-session-log-mirror.mjs'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);
  const streamingToolCalls = events.filter((event) => event.openp?.form === 'streaming' && event.openp.output?.toolCall).length;
  const streamingToolResults = events.filter((event) => event.openp?.form === 'streaming' && event.openp.output?.toolResult).length;
  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingAnswerTexts(events), [
    'stdout first answer',
    'stdout first answer\n\nstdout second answer',
    'stdout first answer\n\nstdout second answer\n\nstdout final answer',
  ]);
  assert.equal(streamingToolCalls, 1);
  assert.equal(streamingToolResults, 1);
  assert.equal(resultAnswerText(terminalResult), 'stdout first answer\n\nstdout second answer\n\nstdout final answer');
  assert.deepEqual(terminalResult.output.toolCall, [{
    type: 'tool_use',
    id: 'call_mirror_tool',
    name: 'exec_command',
    input: { cmd: 'echo tool' },
    caller: { type: 'codex', nativeType: 'function_call' },
  }]);
  assert.deepEqual(terminalResult.output.toolResult, [{
    type: 'tool_result',
    toolUseId: 'call_mirror_tool',
    content: 'tool output from stdout\n',
  }]);
});

test('codex streaming snapshot emits commentary as streaming answer and preserves result in terminal aggregate', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-commentary.sh'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);
  const streamingTexts = streamingAnswerTexts(events);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingTexts, ['checking files...']);
  assert.equal(resultAnswerText(terminalResult), 'checking files...\n\nfinal answer here');
  assert.deepEqual(
    resultAnswerTexts(terminalResult),
    ['checking files...', 'final answer here'],
  );
  assert.equal(resultWarnings(terminalResult), undefined);
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
});

test('codex streaming snapshot keeps terminal result answer event when commentary matches result text', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-commentary-matches-final.sh'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);
  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assertNoTopLevelResultFormEvents(events);
  assert.deepEqual(streamingAnswerTexts(events), ['same answer']);
  assert.deepEqual(
    resultAnswerTexts(terminalResult),
    ['same answer', 'same answer'],
  );
  assert.equal(resultAnswerText(terminalResult), 'same answer\n\nsame answer');
});

test('verbose codex reports streaming-result diagnostic warning for unphased streaming answer outside result', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'fixtures', 'codex', 'fake-codex-item-progress-final.mjs'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--verbose',
    '--debug-log',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);
  const terminalResult = terminalOpenPResult(events);
  const debugEntries = await readDebugEntries(debugLogPath);
  const diagnostic = debugEntries.find((entry) => entry.event === 'streaming_result_diagnostic');

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(resultAnswerText(terminalResult), 'checking sources\n\nsources checked\n\nfinal researched answer');
  assert.equal((resultWarnings(terminalResult) as any[] | undefined)?.[0]?.code, 'streaming_result_diagnostic');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
});
