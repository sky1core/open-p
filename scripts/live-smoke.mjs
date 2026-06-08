#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(rootDir, 'dist', 'src', 'cli.js');
const args = process.argv.slice(2);
const enabled = args.includes('--run');
const timeoutMs = readPositiveIntegerArg('--timeout-ms', '90000');
const backend = readValueArg('--backend') ?? 'claude';

if (!enabled) {
  console.log('Skipping live smoke. Run `npm run smoke:live -- --run` after `npm run build`.');
  process.exit(0);
}

if (!existsSync(cliPath)) {
  throw new Error('dist/src/cli.js is missing. Run npm run build first.');
}

const checks = [
  smokeJsonOutput,
  smokeStreamJsonOutput,
  smokePersistentStreamJsonInput,
  smokeResumeStreamJsonInput,
  smokePublicOptions,
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
  assertOpenPRecord(result, 'json output result record');
  assertEqual(openPResultText(result.openp), 'openp-live-json-ok', 'json output result');
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
  const result = findOpenPResult(events, 'stream-json result');
  assertEqual(openPResultText(result.openp), 'openp-live-stream-json-ok', 'stream-json result');
}

async function smokePersistentStreamJsonInput() {
  const stdout = await runOpenP([
    '--timeout',
    '60',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], [
    userEvent('live-worker-1', 'Return exactly openp-live-worker-first-ok'),
    userEvent('live-worker-2', 'Return exactly openp-live-worker-second-ok'),
  ].join('\n') + '\n');
  const events = parseJsonLines(stdout);
  for (const [index, event] of events.entries()) {
    assertOpenPRecord(event, `persistent stream-json event ${index}`);
  }
  const results = events.filter((event) => event.openp.form === 'result');
  assertEqual(results.length, 2, 'persistent stream-json result count');
  assertEqual(openPResultText(results[0]?.openp), 'openp-live-worker-first-ok', 'persistent stream-json first result');
  assertEqual(openPResultText(results[1]?.openp), 'openp-live-worker-second-ok', 'persistent stream-json second result');
  if (!results[0]?.openp?.sessionId) {
    throw new Error('persistent stream-json first session id is missing');
  }
  assertEqual(results[1]?.openp?.sessionId, results[0].openp.sessionId, 'persistent stream-json second session id');
}

async function smokeResumeStreamJsonInput() {
  const first = await runOpenP([
    '--timeout',
    '60',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], userEvent('live-resume-1', 'Return exactly openp-live-resume-first-ok') + '\n');
  const firstResult = findOpenPResult(parseJsonLines(first), 'resume smoke first result');
  assertEqual(openPResultText(firstResult.openp), 'openp-live-resume-first-ok', 'resume smoke first result');
  const sessionId = firstResult.openp.sessionId;
  if (!sessionId) {
    throw new Error('resume smoke first session id is missing');
  }

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
  const secondResult = findOpenPResult(parseJsonLines(second), 'resume smoke second result');
  assertEqual(openPResultText(secondResult.openp), 'openp-live-resume-second-ok', 'resume smoke second result');
  assertEqual(secondResult.openp.sessionId, sessionId, 'resume smoke second session id');
}

async function smokePublicOptions() {
  const stdout = await runOpenP([
    '--timeout',
    '60',
    '--dangerously-skip-permissions',
    '--verbose',
    ...publicReasoningEffortArgs(),
    '--output-format',
    'json',
    'Return exactly openp-live-public-options-ok',
  ]);
  const result = JSON.parse(stdout);
  assertOpenPRecord(result, 'public options result record');
  assertEqual(openPResultText(result.openp), 'openp-live-public-options-ok', 'public options result');
}

function publicReasoningEffortArgs() {
  return backend === 'kiro' ? [] : ['--effort', 'low'];
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

function findOpenPResult(events, label) {
  for (const event of events) {
    assertOpenPRecord(event, `${label} event`);
  }
  const results = events.filter((event) => event.openp.form === 'result');
  assertEqual(results.length, 1, `${label} result count`);
  if (events.at(-1) !== results[0]) {
    throw new Error(`${label}: result record is not terminal`);
  }
  return results[0];
}

function assertOpenPRecord(event, label) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error(`${label}: expected object`);
  }
  const keys = Object.keys(event);
  if (keys.length !== 1 || keys[0] !== 'openp') {
    throw new Error(`${label}: expected only top-level openp, got ${JSON.stringify(keys)}`);
  }
  const openp = event.openp;
  if (!openp || typeof openp !== 'object' || Array.isArray(openp)) {
    throw new Error(`${label}: missing openp object`);
  }
  if (openp.form !== 'streaming' && openp.form !== 'result') {
    throw new Error(`${label}: invalid openp.form ${JSON.stringify(openp.form)}`);
  }
  if (openp.form === 'result') {
    const output = openp.output;
    const keys = output && typeof output === 'object' && !Array.isArray(output)
      ? Object.keys(output).sort()
      : [];
    assertEqual(JSON.stringify(keys), JSON.stringify(['answer', 'reasoning', 'toolCall', 'toolResult'].sort()), `${label} result output keys`);
  }
}

function openPResultText(openp) {
  const answers = Array.isArray(openp?.output?.answer) ? openp.output.answer : [];
  return answers.filter((answer) => typeof answer === 'string').join('\n\n');
}

function readValueArg(name) {
  const inlinePrefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(inlinePrefix));
  if (inline) {
    const value = inline.slice(inlinePrefix.length);
    if (value.length === 0) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  }
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readPositiveIntegerArg(name, defaultValue) {
  const value = readValueArg(name) ?? defaultValue;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function runOpenP(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, backend, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`live smoke timed out after ${timeoutMs}ms: node ${cliPath} ${backend} ${args.join(' ')}`));
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
