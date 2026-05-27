import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKiroAcpArgs } from '../src/backends/kiro/args.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

test('buildKiroAcpArgs uses ACP subcommand by default', () => {
  const result = buildKiroAcpArgs({});
  assert.deepEqual(result.args, ['acp']);
  assert.equal(result.trustAllTools, false);
});

test('buildKiroAcpArgs adds model', () => {
  const result = buildKiroAcpArgs({ model: 'claude-haiku-4.5' });
  assert.deepEqual(result.args, ['acp', '--model', 'claude-haiku-4.5']);
});

test('buildKiroAcpArgs maps danger-full-access to trust-all-tools', () => {
  const result = buildKiroAcpArgs({ executionMode: 'danger-full-access' });
  assert.deepEqual(result.args, ['acp', '--trust-all-tools']);
  assert.equal(result.trustAllTools, true);
});

test('buildKiroAcpArgs maps public tool allowlist to trust-tools', () => {
  const result = buildKiroAcpArgs({ tools: 'read,grep' });

  assert.deepEqual(result.args, ['acp', '--trust-tools', 'read,grep']);
  assert.equal(result.trustAllTools, false);
});

test('buildKiroAcpArgs treats empty public tool allowlist as trusting no tools', () => {
  const result = buildKiroAcpArgs({ executionMode: 'danger-full-access', tools: '' });

  assert.deepEqual(result.args, ['acp']);
  assert.equal(result.trustAllTools, false);
});

test('buildKiroAcpArgs validates execution mode even when public tool allowlist is present', () => {
  assert.throws(
    () => buildKiroAcpArgs({ executionMode: 'read-only', tools: 'read' }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('buildKiroAcpArgs does not trust tools by default', () => {
  for (const executionMode of [null, 'default']) {
    const result = buildKiroAcpArgs({ executionMode });
    assert.deepEqual(result.args, ['acp']);
    assert.equal(result.trustAllTools, false);
  }
});

test('buildKiroAcpArgs rejects non-canonical execution modes', () => {
  for (const executionMode of ['read-only', 'plan', 'workspace-write', 'acceptEdits', 'auto_edit', 'bypassPermissions', 'yolo']) {
    assert.throws(
      () => buildKiroAcpArgs({ executionMode }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
    );
  }
});

test('buildKiroAcpArgs rejects unsupported backend args', () => {
  assert.throws(
    () => buildKiroAcpArgs({ backendArgs: ['--tools', 'Read,Grep,Glob'] }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
  assert.throws(
    () => buildKiroAcpArgs({ backendArgs: ['--verbose'] }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});
