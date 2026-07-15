import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenPError } from '../src/core/errors.js';
import { parseSeedArgs } from '../src/core/seed-args.js';

const BACKENDS = new Set(['claude', 'codex', 'kiro', 'opencode']);
const UUID = '11111111-1111-4111-8111-111111111111';
const ALPHA_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function exitFor(argv: readonly string[]): number {
  try {
    parseSeedArgs(argv, BACKENDS);
  } catch (error) {
    assert.ok(error instanceof OpenPError, `expected OpenPError, got ${String(error)}`);
    return error.exitCode;
  }
  throw new Error(`expected parseSeedArgs to throw for ${JSON.stringify(argv)}`);
}

test('create mode parses native source session', () => {
  assert.deepEqual(parseSeedArgs(['codex', '--source-backend', 'claude', '--source-session', UUID], BACKENDS), {
    backend: 'codex',
    source: { kind: 'native', backend: 'claude', sessionId: UUID },
    resume: false,
    backendSessionId: null,
    model: null,
    reasoningEffort: null,
    timeoutMs: 0,
  });
});

test('create mode parses external IR source', () => {
  assert.deepEqual(parseSeedArgs(['claude', '--input-ir', '/tmp/ir.json'], BACKENDS), {
    backend: 'claude',
    source: { kind: 'external-ir', path: '/tmp/ir.json' },
    resume: false,
    backendSessionId: null,
    model: null,
    reasoningEffort: null,
    timeoutMs: 0,
  });
});

test('create mode accepts a canonical caller operation id', () => {
  assert.equal(parseSeedArgs([
    'claude',
    '--input-ir', '/tmp/ir.json',
    '--operation-id', UUID,
  ], BACKENDS).operationId, UUID);
});

test('operation id is create-only and must be a canonical UUID v4', () => {
  assert.equal(exitFor([
    'claude',
    '--resume', UUID,
    '--source-backend', 'codex',
    '--source-session', UUID,
    '--operation-id', UUID,
  ]), 2);
  assert.equal(exitFor([
    'claude',
    '--input-ir', '/tmp/ir.json',
    '--operation-id', 'not-a-uuid',
  ]), 2);
  assert.equal(exitFor([
    'claude',
    '--input-ir', '/tmp/ir.json',
    '--operation-id', ALPHA_UUID.toUpperCase(),
  ]), 2);
  assert.equal(exitFor([
    'claude',
    '--input-ir', '/tmp/ir.json',
    '--operation-id', UUID,
    '--operation-id', UUID,
  ]), 2);
});

test('append mode parses resume session id', () => {
  assert.deepEqual(parseSeedArgs(['codex', '--resume', UUID, '--source-backend', 'claude', '--source-session', UUID], BACKENDS), {
    backend: 'codex',
    source: { kind: 'native', backend: 'claude', sessionId: UUID },
    resume: true,
    backendSessionId: UUID,
    model: null,
    reasoningEffort: null,
    timeoutMs: 0,
  });
});

test('missing backend is a usage error', () => {
  assert.equal(exitFor(['--input-ir', '/tmp/h.json']), 2);
});

test('unknown backend is an unsupported-option error (turn parser parity)', () => {
  assert.equal(exitFor(['bogus', '--input-ir', '/tmp/h.json']), 3);
});

test('missing source is a usage error', () => {
  assert.equal(exitFor(['claude']), 2);
});

test('--history is no longer supported', () => {
  assert.equal(exitFor(['claude', '--history', '/tmp/h.json']), 3);
});

test('unsupported flag is exit 3', () => {
  assert.equal(exitFor(['claude', '--input-ir', '/tmp/h.json', '--verbose']), 3);
});

test('extra positional argument is a usage error', () => {
  assert.equal(exitFor(['claude', '--input-ir', '/tmp/h.json', 'extra']), 2);
});

test('missing value for a flag is a usage error', () => {
  assert.equal(exitFor(['claude', '--input-ir']), 2);
  assert.equal(exitFor(['claude', '--input-ir', '--model']), 2);
});

test('unsafe --resume value is a usage error', () => {
  assert.equal(exitFor(['claude', '--resume', 'a/b', '--source-backend', 'codex', '--source-session', UUID]), 2);
  assert.equal(exitFor(['claude', '--resume', '-bad', '--source-backend', 'codex', '--source-session', UUID]), 2);
});

test('append mode rejects create-only tuning flags', () => {
  assert.equal(exitFor(['claude', '--resume', UUID, '--source-backend', 'codex', '--source-session', UUID, '--model', 'opus']), 2);
  assert.equal(exitFor(['claude', '--resume', UUID, '--source-backend', 'codex', '--source-session', UUID, '--effort', 'high']), 2);
  assert.equal(exitFor(['claude', '--resume', UUID, '--source-backend', 'codex', '--source-session', UUID, '--timeout', '0']), 2);
});

test('external IR import is create-only', () => {
  assert.equal(exitFor(['claude', '--resume', UUID, '--input-ir', '/tmp/ir.json']), 2);
});

test('native source requires both source backend and session', () => {
  assert.equal(exitFor(['claude', '--source-backend', 'codex']), 2);
  assert.equal(exitFor(['claude', '--source-session', UUID]), 2);
});

test('native source and external IR are mutually exclusive', () => {
  assert.equal(exitFor(['claude', '--source-backend', 'codex', '--source-session', UUID, '--input-ir', '/tmp/ir.json']), 2);
});

test('--timeout converts seconds to milliseconds identically to the turn CLI', () => {
  assert.equal(parseSeedArgs(['claude', '--input-ir', '/tmp/ir.json', '--timeout', '5'], BACKENDS).timeoutMs, 5000);
  assert.equal(parseSeedArgs(['claude', '--input-ir', '/tmp/ir.json', '--timeout', '1.5'], BACKENDS).timeoutMs, 1500);
  assert.equal(parseSeedArgs(['claude', '--input-ir', '/tmp/ir.json', '--timeout', '0'], BACKENDS).timeoutMs, 0);
  assert.equal(exitFor(['claude', '--input-ir', '/tmp/ir.json', '--timeout', 'abc']), 2);
});
