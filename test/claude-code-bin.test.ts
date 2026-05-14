import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAUDE_CODE_BIN_ENV, resolveClaudeCodeBin } from '../src/backends/claude-code/bin.js';

test('resolves Claude Code binary override only when explicitly configured', () => {
  assert.deepEqual([
    resolveClaudeCodeBin({}),
    resolveClaudeCodeBin({ [CLAUDE_CODE_BIN_ENV]: '/opt/homebrew/bin/claude' }),
    resolveClaudeCodeBin({ [CLAUDE_CODE_BIN_ENV]: '   ' }),
  ], [
    'claude',
    '/opt/homebrew/bin/claude',
    'claude',
  ]);
});
