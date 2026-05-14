import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArgs, parseStreamJsonPrompt, parseStreamJsonUserEventLine, resolvePromptText } from '../src/core/cli-args.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

test('parses supported options and prompt args', () => {
  const options = parseCliArgs([
    '-p',
    '--session-id',
    '11111111-1111-4111-8111-111111111111',
    '--timeout',
    '3',
    '--model',
    'haiku',
    'hello',
    'world',
  ]);

  assert.equal(options.backend, 'claude-code');
  assert.equal(options.provider, 'tmux');
  assert.equal(options.backendSessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(options.resume, false);
  assert.equal(options.timeoutMs, 3000);
  assert.equal(options.model, 'haiku');
  assert.equal(options.appendSystemPrompt, null);
  assert.equal(options.jsonSchema, null);
  assert.equal(options.includePartialMessages, false);
  assert.deepEqual(options.backendArgs, []);
  assert.equal(options.promptArg, 'hello world');
  assert.match(options.turnId, /^[0-9a-f-]{36}$/);
});

test('rejects unsupported options explicitly', () => {
  assert.throws(
    () => parseCliArgs(['--output-format', 'xml', 'hello']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('parses structured output formats explicitly', () => {
  const schema = '{"type":"object"}';
  const options = parseCliArgs(['--output-format', 'json', '--json-schema', schema, 'hello']);
  const streamOptions = parseCliArgs(['--output-format', 'stream-json', '--include-partial-messages', 'hello']);

  assert.equal(options.outputFormat, 'json');
  assert.equal(options.jsonSchema, schema);
  assert.equal(options.promptArg, 'hello');
  assert.equal(streamOptions.outputFormat, 'stream-json');
  assert.equal(streamOptions.includePartialMessages, true);
  assert.equal(streamOptions.promptArg, 'hello');
  assert.deepEqual(streamOptions.backendArgs, []);
});

test('parses append system prompt separately from backend pass-through flags', () => {
  const options = parseCliArgs([
    '--append-system-prompt',
    'caller rules',
    '--system-prompt',
    'system replacement',
    'hello',
  ]);

  assert.equal(options.appendSystemPrompt, 'caller rules');
  assert.deepEqual(options.backendArgs, ['--system-prompt', 'system replacement']);
});

test('rejects malformed json schema before launching backend', () => {
  assert.throws(
    () => parseCliArgs(['--json-schema', 'not-json', 'hello']),
    /--json-schema requires a JSON object/,
  );
  assert.throws(
    () => parseCliArgs(['--include-partial-messages', 'hello']),
    /--include-partial-messages requires --output-format stream-json/,
  );
});

test('parses stream-json input format explicitly', () => {
  const options = parseCliArgs(['--input-format', 'stream-json']);

  assert.equal(options.inputFormat, 'stream-json');
  assert.equal(options.promptArg, null);
});

test('resolves stream-json input from a single user event', () => {
  const prompt = parseStreamJsonPrompt([
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: '  hello\n' },
          { type: 'text', text: '' },
          { type: 'text', text: '  world\n' },
        ],
      },
    }),
  ].join('\n'));

  assert.equal(prompt, '  hello\n  world\n');
});

test('parses one stream-json user event line for worker mode', () => {
  assert.deepEqual(parseStreamJsonUserEventLine(JSON.stringify({
    type: 'user',
    turnId: 'public-turn-1',
    message: {
      content: [
        { type: 'text', text: '  hello\n' },
        { type: 'text', text: '' },
        { type: 'text', text: '  world\n' },
      ],
    },
  }), 1), {
    text: '  hello\n  world\n',
    turnId: 'public-turn-1',
  });
  assert.equal(parseStreamJsonUserEventLine('', 2), null);
});

test('fails closed on unsupported stream-json input shapes', () => {
  assert.throws(() => parseStreamJsonPrompt('not json'), /invalid stream-json input line/);
  assert.throws(
    () => parseStreamJsonPrompt([
      JSON.stringify({ type: 'user', message: { content: 'one' } }),
      JSON.stringify({ type: 'user', message: { content: 'two' } }),
    ].join('\n')),
    /exactly one user event/,
  );
  assert.throws(
    () => parseStreamJsonPrompt(JSON.stringify({ type: 'assistant', message: { content: 'no' } })),
    /unsupported stream-json input event/,
  );
});

test('resolves prompt text according to input format', () => {
  assert.equal(resolvePromptText({
    promptArg: 'argv prompt',
    inputFormat: 'text',
    stdinText: 'stdin prompt',
    stdinIsTty: false,
  }), 'argv prompt');
  assert.equal(resolvePromptText({
    promptArg: null,
    inputFormat: 'text',
    stdinText: 'stdin prompt',
    stdinIsTty: false,
  }), 'stdin prompt');
  assert.throws(
    () => resolvePromptText({
      promptArg: 'argv prompt',
      inputFormat: 'stream-json',
      stdinText: JSON.stringify({ type: 'user', message: { content: 'stdin prompt' } }),
      stdinIsTty: false,
    }),
    /does not accept prompt arguments/,
  );
});

test('preserves timeout zero as disabled timeout', () => {
  const options = parseCliArgs(['--timeout', '0', 'hello']);

  assert.equal(options.timeoutMs, 0);
});

test('preserves supported Claude Code pass-through flags in order', () => {
  const options = parseCliArgs([
    '--verbose',
    '--brief',
    '--allowedTools',
    'Bash',
    '--allowed-tools',
    'Read',
    '--add-dir',
    '/tmp/one',
    '--effort',
    'medium',
    '--mcp-config',
    '/tmp/mcp.json',
    '--add-dir',
    '/tmp/two',
    'hello',
  ]);

  assert.deepEqual(options.backendArgs, [
    '--verbose',
    '--brief',
    '--allowedTools',
    'Bash',
    '--allowed-tools',
    'Read',
    '--add-dir',
    '/tmp/one',
    '--effort',
    'medium',
    '--mcp-config',
    '/tmp/mcp.json',
    '--add-dir',
    '/tmp/two',
  ]);
  assert.equal(options.promptArg, 'hello');
});

test('parses command-shim Claude adapter command shape', () => {
  const schema = '{"type":"object","properties":{"status":{"enum":["pass","fail"]}},"required":["status"]}';
  const options = parseCliArgs([
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'plan',
    '--tools',
    'Read,Grep,Glob',
    '--json-schema',
    schema,
  ]);

  assert.equal(options.promptArg, null);
  assert.equal(options.outputFormat, 'stream-json');
  assert.equal(options.permissionMode, 'plan');
  assert.equal(options.jsonSchema, schema);
  assert.deepEqual(options.backendArgs, ['--verbose', '--tools', 'Read,Grep,Glob']);
});

test('preserves explicit empty pass-through flag values', () => {
  const options = parseCliArgs(['--tools', '', 'hello']);

  assert.deepEqual(options.backendArgs, ['--tools', '']);
  assert.equal(options.promptArg, 'hello');
});

test('rejects non-uuid session ids before they are used as state paths', () => {
  assert.throws(
    () => parseCliArgs(['--session-id', '../outside', 'hello']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.usage,
  );
  assert.throws(
    () => parseCliArgs(['--resume', 'not-a-uuid', 'hello']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.usage,
  );
});
