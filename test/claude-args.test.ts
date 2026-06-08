import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildClaudeCodeArgs } from '../src/backends/claude/adapter.js';
import { buildPersistentClaudeCodeArgs } from '../src/backends/claude/persistent-process.js';
import { buildLaunchSignature } from '../src/core/launch-signature.js';
import type { BackendRunOptions, TurnRequest } from '../src/core/types.js';

const REQUEST: TurnRequest = {
  turnId: 'turn-1',
  prompt: 'hello',
};

const OPTIONS: BackendRunOptions = {
  cwd: '/tmp/workspace',
  backendSessionId: '11111111-1111-4111-8111-111111111111',
  resume: false,
  timeoutMs: 1000,
  model: 'claude-haiku',
  reasoningEffort: null,
  permissionMode: 'acceptEdits',
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

test('builds Claude Code args without one-shot relay and with pass-through flags', () => {
  const args = buildClaudeCodeArgs(OPTIONS);

  assert.deepEqual(args.slice(0, 12), [
    '--model',
    'claude-haiku',
    '--permission-mode',
    'acceptEdits',
    '--disallowedTools',
    'Monitor,Workflow,AskUserQuestion',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--allowedTools',
    'Bash',
    '--add-dir',
    '/tmp/extra',
  ]);
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('--print'), false);
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.includes('--append-system-prompt'), false);
});

test('builds Claude Code args with non-interactive PTY tool suppression: disallowed Monitor, Workflow, AskUserQuestion', () => {
  const args = buildClaudeCodeArgs(OPTIONS);
  const index = args.indexOf('--disallowedTools');
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], 'Monitor,Workflow,AskUserQuestion');
  // The value list ends at the next flag (--settings), so the variadic does not swallow other args.
  assert.equal(args[index + 2], '--settings');
});

test('builds Claude Code args with public reasoning effort option', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    reasoningEffort: 'medium',
  });

  assert.deepEqual(args.slice(0, 6), [
    '--model',
    'claude-haiku',
    '--effort',
    'medium',
    '--permission-mode',
    'acceptEdits',
  ]);
});

test('builds Claude Code args with public tool allowlist option', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    tools: 'Read,Grep',
    backendArgs: [],
  });

  assert.deepEqual(args.slice(-2), ['--tools', 'Read,Grep']);
});

test('builds Claude Code args with empty public tool allowlist', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    tools: '',
    backendArgs: [],
  });

  assert.deepEqual(args.slice(-2), ['--tools', '']);
});

test('buildClaudeCodeArgs rejects raw reasoning effort backend arg', () => {
  assert.throws(
    () => buildClaudeCodeArgs({
      ...OPTIONS,
      backendArgs: ['--effort', 'high'],
    }),
    /unsupported backend arg: --effort/,
  );
  assert.throws(
    () => buildClaudeCodeArgs({
      ...OPTIONS,
      backendArgs: ['--effort=high'],
    }),
    /unsupported backend arg: --effort/,
  );
});

test('buildClaudeCodeArgs rejects raw Claude print and permission backend args', () => {
  for (const backendArgs of [
    ['-p'],
    ['--print'],
    ['--input-format', 'stream-json'],
    ['--input-format=stream-json'],
    ['--output-format', 'stream-json'],
    ['--output-format=stream-json'],
    ['--include-partial-messages'],
    ['--permission-mode', 'bypassPermissions'],
    ['--permission-mode=bypassPermissions'],
    ['--dangerously-skip-permissions'],
  ]) {
    assert.throws(
      () => buildClaudeCodeArgs({
        ...OPTIONS,
        backendArgs,
      }),
      /unsupported backend arg:/,
    );
  }
});

test('builds Claude Code args with json schema pass-through', () => {
  const schema = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}';
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    jsonSchema: schema,
  });

  assert.deepEqual(args.slice(0, 10), [
    '--model',
    'claude-haiku',
    '--permission-mode',
    'acceptEdits',
    '--json-schema',
    schema,
    '--disallowedTools',
    'Monitor,Workflow,AskUserQuestion',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
  ]);
  assert.equal(args.includes('--append-system-prompt'), false);
});

test('builds resume args for known backend sessions', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    resume: true,
    model: null,
    permissionMode: null,
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

  assert.deepEqual(args.slice(2, 10), [
    '--permission-mode',
    'acceptEdits',
    '--disallowedTools',
    'Monitor,Workflow,AskUserQuestion',
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

  assert.deepEqual(args.slice(2, 10), [
    '--permission-mode',
    'plan',
    '--disallowedTools',
    'Monitor,Workflow,AskUserQuestion',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--tools',
    'Read,Bash',
  ]);
});

test('preserves plan permission mode when combined tool policy includes write-capable tools', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    permissionMode: 'plan',
    tools: 'Read',
    backendArgs: ['--allowedTools', 'Bash'],
  });

  const permissionModeIndex = args.indexOf('--permission-mode');
  assert.equal(args[permissionModeIndex + 1], 'plan');
});

test('maps plan permission mode only when combined tool policy is read-only', () => {
  const args = buildClaudeCodeArgs({
    ...OPTIONS,
    permissionMode: 'plan',
    tools: 'Read',
    backendArgs: ['--allowedTools=Grep'],
  });

  const permissionModeIndex = args.indexOf('--permission-mode');
  assert.equal(args[permissionModeIndex + 1], 'acceptEdits');
});

test('merges caller inline settings with thinking summaries for stream-json stream-json parity', () => {
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

test('builds persistent Claude Code args from launch signature', () => {
  const schema = '{"type":"object"}';
  const args = buildPersistentClaudeCodeArgs({
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: true,
    cwd: '/tmp/workspace',
    launchSignature: buildLaunchSignature({
      backendId: 'claude',
      bin: 'claude',
      binArgs: ['--allowedTools', 'Bash'],
      model: 'claude-haiku',
      reasoningEffort: 'medium',
      executionMode: 'danger-full-access',
      tools: 'Read',
      jsonSchema: schema,
    }),
  });

  assert.deepEqual(args.slice(0, 20), [
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
    '--disallowedTools',
    'Monitor,Workflow,AskUserQuestion',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--tools',
    'Read',
    '--allowedTools',
    'Bash',
  ]);
  assert.equal(args.includes('--append-system-prompt'), false);
});

test('buildPersistentClaudeCodeArgs rejects raw reasoning effort backend arg', () => {
  assert.throws(
    () => buildPersistentClaudeCodeArgs({
      sessionId: '11111111-1111-4111-8111-111111111111',
      resume: false,
      cwd: '/tmp/workspace',
      launchSignature: buildLaunchSignature({
        backendId: 'claude',
        bin: 'claude',
        binArgs: ['--effort', 'high'],
        model: null,
        reasoningEffort: 'low',
        executionMode: null,
        jsonSchema: null,
        env: {},
        local: false,
      }),
    }),
    /unsupported backend arg: --effort/,
  );
  assert.throws(
    () => buildPersistentClaudeCodeArgs({
      sessionId: '11111111-1111-4111-8111-111111111111',
      resume: false,
      cwd: '/tmp/workspace',
      launchSignature: buildLaunchSignature({
        backendId: 'claude',
        bin: 'claude',
        binArgs: ['--effort=high'],
        model: null,
        reasoningEffort: 'low',
        executionMode: null,
        jsonSchema: null,
        env: {},
        local: false,
      }),
    }),
    /unsupported backend arg: --effort/,
  );
});

test('buildPersistentClaudeCodeArgs rejects raw Claude print and permission backend args', () => {
  for (const binArgs of [
    ['-p'],
    ['--print'],
    ['--input-format', 'stream-json'],
    ['--input-format=stream-json'],
    ['--output-format', 'stream-json'],
    ['--output-format=stream-json'],
    ['--include-partial-messages'],
    ['--permission-mode', 'bypassPermissions'],
    ['--permission-mode=bypassPermissions'],
    ['--dangerously-skip-permissions'],
  ]) {
    assert.throws(
      () => buildPersistentClaudeCodeArgs({
        sessionId: '11111111-1111-4111-8111-111111111111',
        resume: false,
        cwd: '/tmp/workspace',
        launchSignature: buildLaunchSignature({
          backendId: 'claude',
          bin: 'claude',
          binArgs,
          model: null,
          reasoningEffort: null,
          executionMode: null,
          jsonSchema: null,
          env: {},
          local: false,
        }),
      }),
      /unsupported backend arg:/,
    );
  }
});

test('persistent Claude Code args merge caller settings with thinking summaries', () => {
  const args = buildPersistentClaudeCodeArgs({
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    cwd: '/tmp/workspace',
    launchSignature: buildLaunchSignature({
      backendId: 'claude',
      bin: 'claude',
      binArgs: ['--settings', '{"showThinkingSummaries":false,"allowedTools":["Read"]}'],
    }),
  });

  const settingsIndexes = args
    .map((arg, index) => arg === '--settings' ? index : -1)
    .filter((index) => index >= 0);
  assert.deepEqual(settingsIndexes, [4]);
  assert.equal(args.includes('--session-id'), false);
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
    launchSignature: buildLaunchSignature({
      backendId: 'claude',
      bin: 'claude',
      binArgs: ['--tools', 'Read,Grep,Glob'],
      executionMode: 'plan',
    }),
  });

  assert.deepEqual(args.slice(0, 9), [
    '--verbose',
    '--brief',
    '--permission-mode',
    'acceptEdits',
    '--disallowedTools',
    'Monitor,Workflow,AskUserQuestion',
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
    launchSignature: buildLaunchSignature({
      backendId: 'claude',
      bin: 'claude',
      binArgs: ['--brief', '--verbose', '--allowedTools', 'Bash'],
    }),
  });

  assert.equal(args.filter((arg) => arg === '--brief').length, 1);
  assert.equal(args.filter((arg) => arg === '--verbose').length, 1);
  assert.deepEqual(args.slice(0, 8), [
    '--verbose',
    '--brief',
    '--disallowedTools',
    'Monitor,Workflow,AskUserQuestion',
    '--settings',
    THINKING_SUMMARIES_SETTINGS,
    '--allowedTools',
    'Bash',
  ]);
  assert.equal(args.includes('--append-system-prompt'), false);
});
