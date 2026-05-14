#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(rootDir, 'dist', 'src', 'cli.js');
const mcpConfigPath = join(rootDir, 'test', 'fixtures', 'live-smoke', 'mcp-config.json');
const settingsPath = join(rootDir, 'test', 'fixtures', 'live-smoke', 'settings.json');
const enabled = process.env.OPENP_LIVE_SMOKE === '1';
const timeoutMs = Number.parseInt(process.env.OPENP_LIVE_SMOKE_TIMEOUT_MS ?? '90000', 10);

if (!enabled) {
  console.log('Skipping live smoke. Set OPENP_LIVE_SMOKE=1 after running npm run build.');
  process.exit(0);
}

if (!existsSync(cliPath)) {
  throw new Error('dist/src/cli.js is missing. Run npm run build first.');
}
if (!existsSync(mcpConfigPath) || !existsSync(settingsPath)) {
  throw new Error('live smoke fixture config files are missing.');
}

const checks = [
  smokeJsonOutput,
  smokeStreamJsonOutput,
  smokePersistentStreamJsonInput,
  smokeResumeStreamJsonInput,
  smokeSafePassThroughFlags,
  smokeEmptyToolsFlag,
];

for (const check of checks) {
  await check();
}

console.log('Live smoke checks passed.');

async function smokeJsonOutput() {
  const stdout = await runOpenP([
    '--timeout',
    '60',
    '--output-format',
    'json',
    'Return exactly openp-live-json-ok',
  ]);
  const result = JSON.parse(stdout);
  assertEqual(result.result, 'openp-live-json-ok', 'json output result');
}

async function smokeStreamJsonOutput() {
  const stdout = await runOpenP([
    '--timeout',
    '60',
    '--output-format',
    'stream-json',
    'Return exactly openp-live-stream-json-ok',
  ]);
  const events = parseJsonLines(stdout);
  const result = events.find((event) => event.type === 'result');
  assertEqual(result?.result, 'openp-live-stream-json-ok', 'stream-json result');
}

async function smokePersistentStreamJsonInput() {
  const sessionId = randomUUID();
  const stdout = await runOpenP([
    '--timeout',
    '60',
    '--session-id',
    sessionId,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], [
    userEvent('live-worker-1', 'Return exactly openp-live-worker-first-ok'),
    userEvent('live-worker-2', 'Return exactly openp-live-worker-second-ok'),
  ].join('\n') + '\n');
  const results = parseJsonLines(stdout).filter((event) => event.type === 'result');
  assertEqual(results.length, 2, 'persistent stream-json result count');
  assertEqual(results[0]?.result, 'openp-live-worker-first-ok', 'persistent stream-json first result');
  assertEqual(results[1]?.result, 'openp-live-worker-second-ok', 'persistent stream-json second result');
  assertEqual(results[0]?.session_id, sessionId, 'persistent stream-json first session id');
  assertEqual(results[1]?.session_id, sessionId, 'persistent stream-json second session id');
}

async function smokeResumeStreamJsonInput() {
  const sessionId = randomUUID();
  const first = await runOpenP([
    '--timeout',
    '60',
    '--session-id',
    sessionId,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], userEvent('live-resume-1', 'Return exactly openp-live-resume-first-ok') + '\n');
  const firstResult = parseJsonLines(first).find((event) => event.type === 'result');
  assertEqual(firstResult?.result, 'openp-live-resume-first-ok', 'resume smoke first result');
  assertEqual(firstResult?.session_id, sessionId, 'resume smoke first session id');

  const second = await runOpenP([
    '--timeout',
    '60',
    '--resume',
    sessionId,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], userEvent('live-resume-2', 'Return exactly openp-live-resume-second-ok') + '\n');
  const secondResult = parseJsonLines(second).find((event) => event.type === 'result');
  assertEqual(secondResult?.result, 'openp-live-resume-second-ok', 'resume smoke second result');
  assertEqual(secondResult?.session_id, sessionId, 'resume smoke second session id');
}

async function smokeSafePassThroughFlags() {
  const stdout = await runOpenP([
    '--timeout',
    '60',
    '--permission-mode',
    'bypassPermissions',
    '--brief',
    '--verbose',
    '--allowed-tools',
    'Read',
    '--disallowed-tools',
    'Bash',
    '--add-dir',
    rootDir,
    '--effort',
    'low',
    '--mcp-config',
    mcpConfigPath,
    '--settings',
    settingsPath,
    '--setting-sources',
    'user,project,local',
    '--output-format',
    'json',
    'Return exactly openp-live-pass-flags-ok',
  ]);
  const result = JSON.parse(stdout);
  assertEqual(result.result, 'openp-live-pass-flags-ok', 'safe pass-through flags result');
}

async function smokeEmptyToolsFlag() {
  const stdout = await runOpenP([
    '--timeout',
    '60',
    '--tools',
    '',
    '--output-format',
    'json',
    'Return exactly openp-live-empty-tools-ok',
  ]);
  const result = JSON.parse(stdout);
  assertEqual(result.result, 'openp-live-empty-tools-ok', 'empty tools flag result');
}

function userEvent(turnId, text) {
  return JSON.stringify({
    type: 'user',
    turnId,
    message: { content: text },
  });
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function runOpenP(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`live smoke timed out after ${timeoutMs}ms: node ${cliPath} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`openp exited with code ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    child.stdin.end(input);
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
