import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildClaudeCodeArgs } from '../src/backends/claude-code/adapter.js';
import { buildPersistentClaudeCodeArgs } from '../src/backends/claude-code/persistent-process.js';
import { buildLaunchSignature } from '../src/core/launch-signature.js';
import type { BackendRunOptions, TurnRequest } from '../src/core/types.js';

const REQUEST: TurnRequest = {
  turnId: 'turn-1',
  prompt: 'hello',
};

const OPTIONS: BackendRunOptions = {
  cwd: '/tmp/workspace',
  provider: 'tmux',
  backendSessionId: '11111111-1111-4111-8111-111111111111',
  resume: false,
  timeoutMs: 1000,
  model: 'claude-haiku',
  permissionMode: 'acceptEdits',
  appendSystemPrompt: null,
  jsonSchema: null,
  backendArgs: [
    '--allowedTools',
    'Bash',
    '--add-dir',
    '/tmp/extra',
  ],
  debugLog: null,
};

const THINKING_SUMMARIES_SETTINGS = '{"showThinkingSummaries":true}';

test('builds Claude Code args without print mode and with pass-through flags', () => {
  const args = buildClaudeCodeArgs(OPTIONS);

  assert.deepEqual(args.slice(0, 12), [
    '--session-id',
    '11111111-1111-4111-8111-111111111111',
    '--model',
    'claude-haiku',
    '--permission-mode',
    'acceptEdits',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--allowedTools',
    'Bash',
    '--add-dir',
    '/tmp/extra',
  ]);
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('--print'), false);
  assert.equal(args.includes('--append-system-prompt'), false);
});

test('builds Claude Code args with caller append prompt and json schema pass-through', () => {
  const schema = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}';
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    appendSystemPrompt: 'caller rules',
    jsonSchema: schema,
  });

  assert.deepEqual(args.slice(0, 10), [
    '--session-id',
    '11111111-1111-4111-8111-111111111111',
    '--model',
    'claude-haiku',
    '--permission-mode',
    'acceptEdits',
    '--json-schema',
    schema,
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
  ]);
  assert.equal(args.at(-2), '--append-system-prompt');
  assert.equal(args.at(-1), 'caller rules');
});

test('builds resume args for known backend sessions', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    resume: true,
    model: null,
    permissionMode: null,
    appendSystemPrompt: null,
    jsonSchema: null,
    backendArgs: [],
  });

  assert.equal(args[0], '--resume');
  assert.equal(args[1], '11111111-1111-4111-8111-111111111111');
});

test('maps plan permission mode with read-only tools to interactive-safe acceptEdits', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    permissionMode: 'plan',
    backendArgs: ['--tools', 'Read,Grep,Glob'],
  });

  assert.deepEqual(args.slice(4, 10), [
    '--permission-mode',
    'acceptEdits',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--tools',
    'Read,Grep,Glob',
  ]);
});

test('preserves plan permission mode when write-capable tools may be available', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    permissionMode: 'plan',
    backendArgs: ['--tools', 'Read,Bash'],
  });

  assert.deepEqual(args.slice(4, 10), [
    '--permission-mode',
    'plan',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--tools',
    'Read,Bash',
  ]);
});

test('merges caller inline settings with thinking summaries for Claude -p stream-json parity', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    backendArgs: ['--settings', '{"showThinkingSummaries":false,"allowedTools":["Read"]}'],
  });

  const settingsIndexes = args
    .map((arg, index) => arg === '--settings' ? index : -1)
    .filter((index) => index >= 0);
  assert.deepEqual(settingsIndexes, [6]);
  assert.deepEqual(JSON.parse(args[settingsIndexes[0] + 1]!), {
    showThinkingSummaries: true,
    allowedTools: ['Read'],
  });
});

test('merges caller settings file with thinking summaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openp-settings-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    apiKeyHelper: '/opt/helper',
    showThinkingSummaries: false,
  }));
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    cwd: dir,
    backendArgs: ['--settings', 'settings.json', '--allowedTools', 'Read'],
  });

  const settingsIndex = args.indexOf('--settings');
  assert.equal(settingsIndex, 6);
  const mergedSettingsPath = args[settingsIndex + 1]!;
  assert.equal(mergedSettingsPath.startsWith(tmpdir()), true);
  assert.equal(statSync(mergedSettingsPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(mergedSettingsPath, 'utf8')), {
    apiKeyHelper: '/opt/helper',
    showThinkingSummaries: true,
  });
  assert.deepEqual(args.slice(settingsIndex + 2), ['--allowedTools', 'Read']);
});

test('merges caller JSONC settings file with thinking summaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openp-settings-jsonc-'));
  writeFileSync(join(dir, 'settings.json'), `{
    // Claude Code accepts comments in settings files.
    "apiKeyHelper": "/opt/helper",
    "allowedTools": [
      "Read",
    ],
    "showThinkingSummaries": false,
  }
`);
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    cwd: dir,
    backendArgs: ['--settings', 'settings.json'],
  });

  const settingsIndex = args.indexOf('--settings');
  const mergedSettingsPath = args[settingsIndex + 1]!;
  assert.deepEqual(JSON.parse(readFileSync(mergedSettingsPath, 'utf8')), {
    apiKeyHelper: '/opt/helper',
    allowedTools: ['Read'],
    showThinkingSummaries: true,
  });
});

test('merges caller JSONC inline settings with thinking summaries', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    backendArgs: ['--settings', '{"allowedTools":["Read",],"showThinkingSummaries":false,}'],
  });

  const settingsIndex = args.indexOf('--settings');
  assert.deepEqual(JSON.parse(args[settingsIndex + 1]!), {
    allowedTools: ['Read'],
    showThinkingSummaries: true,
  });
});

test('builds persistent Claude Code args from launch signature and append prompt', () => {
  const schema = '{"type":"object"}';
  const args = buildPersistentClaudeCodeArgs({
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: true,
    cwd: '/tmp/workspace',
    appendSystemPrompt: 'extra system rules',
    launchSignature: buildLaunchSignature({
      backendId: 'claude-code',
      bin: 'claude',
      binArgs: ['--allowedTools', 'Bash'],
      model: 'claude-haiku',
      reasoningEffort: 'medium',
      executionMode: 'bypassPermissions',
      jsonSchema: schema,
    }),
  });

  assert.deepEqual(args.slice(0, 16), [
    '--resume',
    '11111111-1111-4111-8111-111111111111',
    '--verbose',
    '--brief',
    '--model',
    'claude-haiku',
    '--effort',
    'medium',
    '--permission-mode',
    'bypassPermissions',
    '--json-schema',
    schema,
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--allowedTools',
    'Bash',
  ]);
  assert.equal(args.at(-2), '--append-system-prompt');
  assert.equal(args.at(-1), 'extra system rules');
});

test('persistent Claude Code args merge caller settings with thinking summaries', () => {
  const args = buildPersistentClaudeCodeArgs({
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    cwd: '/tmp/workspace',
    appendSystemPrompt: null,
    launchSignature: buildLaunchSignature({
      backendId: 'claude-code',
      bin: 'claude',
      binArgs: ['--settings', '{"showThinkingSummaries":false,"allowedTools":["Read"]}'],
    }),
  });

  const settingsIndexes = args
    .map((arg, index) => arg === '--settings' ? index : -1)
    .filter((index) => index >= 0);
  assert.deepEqual(settingsIndexes, [4]);
  assert.deepEqual(JSON.parse(args[settingsIndexes[0] + 1]!), {
    showThinkingSummaries: true,
    allowedTools: ['Read'],
  });
});

test('persistent Claude Code args map plan with read-only tools to interactive-safe acceptEdits', () => {
  const args = buildPersistentClaudeCodeArgs({
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    cwd: '/tmp/workspace',
    appendSystemPrompt: null,
    launchSignature: buildLaunchSignature({
      backendId: 'claude-code',
      bin: 'claude',
      binArgs: ['--tools', 'Read,Grep,Glob'],
      executionMode: 'plan',
    }),
  });

  assert.deepEqual(args.slice(2, 9), [
    '--verbose',
    '--brief',
    '--permission-mode',
    'acceptEdits',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--tools',
  ]);
  assert.equal(args[9], 'Read,Grep,Glob');
});

test('persistent Claude Code args do not duplicate built-in compatibility flags', () => {
  const args = buildPersistentClaudeCodeArgs({
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    cwd: '/tmp/workspace',
    appendSystemPrompt: null,
    launchSignature: buildLaunchSignature({
      backendId: 'claude-code',
      bin: 'claude',
      binArgs: ['--brief', '--verbose', '--allowedTools', 'Bash'],
    }),
  });

  assert.equal(args.filter((arg) => arg === '--brief').length, 1);
  assert.equal(args.filter((arg) => arg === '--verbose').length, 1);
  assert.deepEqual(args.slice(0, 8), [
    '--session-id',
    '11111111-1111-4111-8111-111111111111',
    '--verbose',
    '--brief',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--allowedTools',
    'Bash',
  ]);
  assert.equal(args.includes('--append-system-prompt'), false);
});
