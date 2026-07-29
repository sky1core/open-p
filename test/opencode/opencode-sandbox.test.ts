import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocalhostOnlySandboxCommand,
  LOCALHOST_ONLY_SANDBOX_PROFILE,
} from '../../src/backends/opencode/sandbox.js';

test('buildLocalhostOnlySandboxCommand wraps OpenCode in localhost-only sandbox', () => {
  const command = buildLocalhostOnlySandboxCommand('opencode', ['run']);
  assert.equal(command.bin, '/usr/bin/sandbox-exec');
  assert.deepEqual(command.args, ['-p', LOCALHOST_ONLY_SANDBOX_PROFILE, 'opencode', 'run']);
  assert.match(LOCALHOST_ONLY_SANDBOX_PROFILE, /deny network\*/);
  assert.match(LOCALHOST_ONLY_SANDBOX_PROFILE, /localhost:\*/);
});
