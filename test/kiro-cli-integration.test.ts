import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import {
  KIRO_SESSION_ID,
  collectChild,
  parseOutputLine,
  readDebugEntries,
  resultAnswerText,
  runCommand,
  streamingAnswerTexts,
  terminalOpenPResult,
  waitForFile,
  withFakeCommandEnv,
} from './helpers/cli-integration.js';

test('kiro first turn returns generated session id and resume uses that id', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const kiroHome = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const rpcLog = join(stateRoot, 'kiro-rpc.log');
  const env = await withFakeCommandEnv('kiro-cli', join(repoRoot, 'test', 'fixtures', 'kiro', 'fake-kiro-acp.mjs'), {
    XDG_STATE_HOME: stateRoot,
    HOME: kiroHome,
    OPENP_FAKE_KIRO_BEHAVIOR: 'success',
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '1',
    OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
  });

  const first = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
    '--output-format',
    'json',
    'hello',
  ], projectRoot, env);
  const firstEvent = parseOutputLine(first.stdout);

  assert.equal(first.code, 0);
  assert.equal(firstEvent.openp.sessionId, KIRO_SESSION_ID);
  await stat(join(workspaceStateRoot, 'sessions', `${KIRO_SESSION_ID}.json`));

  const resume = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
    '--resume',
    KIRO_SESSION_ID,
    'follow up',
  ], projectRoot, env);

  assert.equal(resume.code, 0);
  assert.equal(resume.stdout, 'fresh answer\n');
  assert.equal(resume.stderr, '');

  const rpcLines = (await readFile(rpcLog, 'utf8')).trimEnd().split('\n');
  assert.match(rpcLines.join('\n'), /session\/new/);
  assert.match(rpcLines.join('\n'), new RegExp(`session/load\\t.*${KIRO_SESSION_ID}`));
  assert.match(rpcLines.at(-1)!, /session\/prompt/);
});

test('kiro stream-json first turn omits init session and returns generated result session id', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const kiroHome = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const env = await withFakeCommandEnv('kiro-cli', join(repoRoot, 'test', 'fixtures', 'kiro', 'fake-kiro-acp.mjs'), {
    XDG_STATE_HOME: stateRoot,
    HOME: kiroHome,
    OPENP_FAKE_KIRO_BEHAVIOR: 'success',
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '1',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
    '--output-format',
    'stream-json',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(events.map((event) => event.openp.form), ['result']);
  assert.equal(events.at(-1)?.openp.form, 'result');
  assert.equal(events.at(-1)?.openp.sessionId, KIRO_SESSION_ID);
  assert.equal(events.at(-1)?.openp.metadata?.rawUsage?.contextUsagePercentage, 2.5);
  await stat(join(workspaceStateRoot, 'sessions', `${KIRO_SESSION_ID}.json`));
});

test('kiro slash-command turn returns chunk text once as stream-json result answer', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const kiroHome = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  const env = await withFakeCommandEnv('kiro-cli', join(repoRoot, 'test', 'fixtures', 'kiro', 'fake-kiro-acp.mjs'), {
    XDG_STATE_HOME: stateRoot,
    HOME: kiroHome,
    OPENP_FAKE_KIRO_BEHAVIOR: 'slash-command',
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '1',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
    '--output-format',
    'stream-json',
    '/compact',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);
  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(events.map((event) => event.openp.form), ['result']);
  assert.deepEqual(terminalResult.output.answer, ['Conversation too short to compact.']);
  assert.deepEqual(terminalResult.output.toolCall, []);
  assert.deepEqual(terminalResult.output.toolResult, []);
});

test('kiro streaming snapshot accumulates chunks and result matches streamed answer', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const kiroHome = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  const env = await withFakeCommandEnv('kiro-cli', join(repoRoot, 'test', 'fixtures', 'kiro', 'fake-kiro-acp.mjs'), {
    XDG_STATE_HOME: stateRoot,
    HOME: kiroHome,
    OPENP_FAKE_KIRO_BEHAVIOR: 'multi-chunk',
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '1',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
    '--output-format',
    'stream-json',
    '--streaming',
    'hello',
  ], projectRoot, env);
  const events = result.stdout.trimEnd().split('\n').map(parseOutputLine);
  const streamingTexts = streamingAnswerTexts(events);
  const streamedText = streamingTexts.at(-1) ?? '';
  const assistant = events.filter((event) => event.openp?.form === 'streaming').at(-1)?.openp;
  const terminalResult = terminalOpenPResult(events);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(streamingTexts, ['alpha ', 'alpha beta ', 'alpha beta gamma']);
  assert.equal(streamedText, 'alpha beta gamma');
  assert.equal(assistant?.output?.answer, streamedText);
  assert.equal(resultAnswerText(terminalResult), streamedText);
});

test('kiro keeps session-log result and logs streaming snapshot outside result', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const kiroHome = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = await withFakeCommandEnv('kiro-cli', join(repoRoot, 'test', 'fixtures', 'kiro', 'fake-kiro-acp.mjs'), {
    XDG_STATE_HOME: stateRoot,
    HOME: kiroHome,
    OPENP_FAKE_KIRO_BEHAVIOR: 'log-final-diff',
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '1',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
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
  assert.deepEqual(streamingTexts, ['draft ']);
  assert.equal(resultAnswerText(terminalResult), 'authoritative final');
  assert.equal(diagnostic?.issues?.[0]?.kind, 'streaming-answer-outside-result');
});

test('kiro CLI debug log records artifact rejection reason code on error', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const kiroHome = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const env = await withFakeCommandEnv('kiro-cli', join(repoRoot, 'test', 'fixtures', 'kiro', 'fake-kiro-acp.mjs'), {
    XDG_STATE_HOME: stateRoot,
    HOME: kiroHome,
    OPENP_FAKE_KIRO_BEHAVIOR: 'success',
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '0',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
    '--debug-log',
    'hello',
  ], projectRoot, env);
  const entries = await readDebugEntries(debugLogPath);
  const errorEntry = entries.find((entry) => entry.event === 'error');

  assert.equal(result.code, 41);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Kiro session log not found/);
  assert.equal(errorEntry?.reasonCode, 'no_candidate');
});

test('text CLI maps SIGINT to backend graceful interrupt before exiting 130', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const signalLog = join(stateRoot, 'kiro-signals.log');
  const rpcLog = join(stateRoot, 'kiro-rpc.log');
  const env = await withFakeCommandEnv('kiro-cli', join(repoRoot, 'test', 'fixtures', 'kiro', 'fake-kiro-acp.mjs'), {
    ...process.env,
    XDG_STATE_HOME: stateRoot,
    OPENP_FAKE_KIRO_BEHAVIOR: 'slow',
    OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
    OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog,
  });
  const child = spawn(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'kiro',
    'hello',
  ], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForFile(rpcLog);
  child.kill('SIGINT');
  const result = await collectChild(child);

  assert.equal(result.code, 130);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /operation aborted/);
  assert.deepEqual((await readFile(signalLog, 'utf8')).trimEnd().split('\n'), ['SIGINT']);
});
