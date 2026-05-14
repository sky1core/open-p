import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaudeCodeScreenAssistantText } from '../src/backends/claude-code/screen-parser.js';

test('extracts the latest Claude Code assistant text from a tmux screen capture', () => {
  const screen = [
    ' ▐▛███▜▌   Claude Code v2.1.142',
    '▝▜█████▛▘  Haiku 4.5 · Claude Max',
    '  ▘▘ ▝▝    ~/projects/example-app',
    '',
    '❯ Say hello',
    '',
    '⏺ hello',
    '  world',
    '',
    '✻ Crunched for 1s',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)                   52513 tokens',
  ].join('\n');

  assert.equal(extractClaudeCodeScreenAssistantText(screen), 'hello\nworld');
});

test('uses the last assistant block when an older response is still visible', () => {
  const screen = [
    '⏺ old response',
    '',
    '❯ Next prompt',
    '',
    '⏺ new response line 1',
    '  new response line 2',
  ].join('\n');

  assert.equal(extractClaudeCodeScreenAssistantText(screen), 'new response line 1\nnew response line 2');
});

test('does not reuse stale assistant text after a newer non-empty prompt', () => {
  const screen = [
    '⏺ old response',
    '',
    '❯ current prompt',
    '✻ Thinking',
  ].join('\n');

  assert.equal(extractClaudeCodeScreenAssistantText(screen), null);
});

test('does not treat prompt markers inside assistant prose as a newer user prompt', () => {
  const screen = [
    '❯ Explain command prompts',
    '',
    '⏺ The prompt marker can appear in prose:',
    '  ❯ npm test',
    '  and the answer should continue.',
  ].join('\n');

  assert.equal(
    extractClaudeCodeScreenAssistantText(screen),
    'The prompt marker can appear in prose:\n❯ npm test\nand the answer should continue.',
  );
});

test('does not treat Claude Code tool marker blocks as assistant prose', () => {
  const screen = [
    '❯ Inspect package',
    '',
    '⏺ Read(package.json)',
    '  ⎿  Read 42 lines',
  ].join('\n');

  assert.equal(extractClaudeCodeScreenAssistantText(screen), null);
});

test('does not treat Claude Code status marker headings as assistant prose', () => {
  const screen = [
    '❯ Update the todos',
    '',
    '⏺ Update Todos',
    '  ☒ First item',
    '  ☐ Second item',
  ].join('\n');

  assert.equal(extractClaudeCodeScreenAssistantText(screen), null);
});

test('returns null when no assistant marker is visible', () => {
  assert.equal(extractClaudeCodeScreenAssistantText('❯ Waiting for input'), null);
});
