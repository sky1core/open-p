import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFirstTurnArgs, buildResumeTurnArgs, validateCodexBackendArgs } from '../src/backends/codex/args.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const BASE_OPTIONS = {
  outputLastMessagePath: '/tmp/last.txt',
};

test('buildFirstTurnArgs does not add bypass sandbox args by default', () => {
  for (const executionMode of [undefined, 'default']) {
    const args = buildFirstTurnArgs('hello', { ...BASE_OPTIONS, executionMode });
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(args.includes('exec'));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--output-last-message'));
    assert.equal(args.at(-1), 'hello');
  }
});

test('buildFirstTurnArgs maps danger-full-access to bypass sandbox args', () => {
  const args = buildFirstTurnArgs('hello', { ...BASE_OPTIONS, executionMode: 'danger-full-access' });
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('buildFirstTurnArgs includes model when specified', () => {
  const args = buildFirstTurnArgs('hello', { ...BASE_OPTIONS, model: 'gpt-5.5' });
  const modelIdx = args.indexOf('--model');
  assert.ok(modelIdx >= 0);
  assert.equal(args[modelIdx + 1], 'gpt-5.5');
});

test('buildFirstTurnArgs includes reasoning effort as config override', () => {
  const args = buildFirstTurnArgs('hello', { ...BASE_OPTIONS, reasoningEffort: 'high' });
  const cIdx = args.indexOf('-c');
  assert.ok(cIdx >= 0);
  assert.equal(args[cIdx + 1], 'model_reasoning_effort="high"');
});

test('buildFirstTurnArgs uses sandbox mode for read-only', () => {
  const args = buildFirstTurnArgs('hello', { ...BASE_OPTIONS, executionMode: 'read-only' });
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('--ask-for-approval'));
  assert.ok(args.includes('never'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('buildFirstTurnArgs rejects unsupported execution modes instead of falling back to trusted tools', () => {
  assert.throws(
    () => buildFirstTurnArgs('hello', { ...BASE_OPTIONS, executionMode: 'unknown-mode' }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('buildFirstTurnArgs rejects public tool allowlist because Codex has no verified tool surface', () => {
  assert.throws(
    () => buildFirstTurnArgs('hello', { ...BASE_OPTIONS, tools: 'Read,Grep' }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('buildFirstTurnArgs includes output-schema on first turn', () => {
  const args = buildFirstTurnArgs('hello', { ...BASE_OPTIONS, outputSchemaPath: '/tmp/schema.json' });
  assert.ok(args.includes('--output-schema'));
  const schemaIdx = args.indexOf('--output-schema');
  assert.equal(args[schemaIdx + 1], '/tmp/schema.json');
});

test('buildFirstTurnArgs includes -C for cwd', () => {
  const args = buildFirstTurnArgs('hello', { ...BASE_OPTIONS, cwd: '/my/project' });
  const cIdx = args.indexOf('-C');
  assert.ok(cIdx >= 0);
  assert.equal(args[cIdx + 1], '/my/project');
});

test('buildResumeTurnArgs uses config override for sandbox on resume', () => {
  const args = buildResumeTurnArgs('session-uuid', 'hello', { ...BASE_OPTIONS, executionMode: 'workspace-write' });
  assert.ok(!args.includes('--sandbox'));
  const cIndices = args.reduce((acc: number[], a, i) => a === '-c' ? [...acc, i] : acc, []);
  const sandboxOverride = cIndices.some(i => args[i + 1] === 'sandbox_mode="workspace-write"');
  const approvalOverride = cIndices.some(i => args[i + 1] === 'approval_policy="never"');
  assert.ok(sandboxOverride, 'should have sandbox_mode config override');
  assert.ok(approvalOverride, 'should have approval_policy config override');
});

test('buildResumeTurnArgs does not add bypass sandbox args by default', () => {
  const args = buildResumeTurnArgs('session-uuid', 'hello', { ...BASE_OPTIONS, executionMode: 'default' });

  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(args.includes('resume'));
});

test('buildResumeTurnArgs maps danger-full-access to bypass sandbox args', () => {
  const args = buildResumeTurnArgs('session-uuid', 'hello', { ...BASE_OPTIONS, executionMode: 'danger-full-access' });
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('buildResumeTurnArgs rejects unsupported execution modes instead of falling back to trusted tools', () => {
  assert.throws(
    () => buildResumeTurnArgs('session-uuid', 'hello', { ...BASE_OPTIONS, executionMode: 'unknown-mode' }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('buildResumeTurnArgs rejects public tool allowlist because Codex has no verified tool surface', () => {
  assert.throws(
    () => buildResumeTurnArgs('session-uuid', 'hello', { ...BASE_OPTIONS, tools: 'Read,Grep' }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('buildResumeTurnArgs places session id and prompt as trailing positional args', () => {
  const args = buildResumeTurnArgs('my-session-id', 'follow up', BASE_OPTIONS);
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('resume'));
  const lastTwo = args.slice(-2);
  assert.deepEqual(lastTwo, ['my-session-id', 'follow up']);
});

test('buildResumeTurnArgs does not include -C', () => {
  const args = buildResumeTurnArgs('sid', 'hello', { ...BASE_OPTIONS, cwd: '/my/project' });
  assert.ok(!args.includes('-C'));
});

test('buildResumeTurnArgs includes output-schema before session and prompt', () => {
  const args = buildResumeTurnArgs('sid', 'hello', { ...BASE_OPTIONS, outputSchemaPath: '/tmp/schema.json' });
  const schemaIdx = args.indexOf('--output-schema');
  assert.ok(schemaIdx >= 0);
  assert.equal(args[schemaIdx + 1], '/tmp/schema.json');
  assert.ok(schemaIdx < args.indexOf('sid'));
});

test('validateCodexBackendArgs rejects unsupported backend args', () => {
  assert.equal(validateCodexBackendArgs([]), undefined);
  assert.throws(
    () => validateCodexBackendArgs(['--tools', 'Read,Grep,Glob']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
  assert.throws(
    () => validateCodexBackendArgs(['--effort', 'high']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});
