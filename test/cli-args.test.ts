import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCliArgs,
  parseDebugLogOption,
  parseVerboseOption,
  parseStreamJsonPrompt,
  parseStreamJsonUserEventLine,
  resolvePromptText,
} from '../src/core/cli-args.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

test('parses supported options and prompt args', () => {
  const options = parseCliArgs([
    '--timeout',
    '3',
    '--model',
    'haiku',
    '--effort',
    'high',
    '--tools',
    'Read,Bash',
    'hello',
    'world',
  ]);

  assert.equal(options.backend, 'claude');
  assert.match(options.backendSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(options.resume, false);
  assert.equal(options.timeoutMs, 3000);
  assert.equal(options.model, 'haiku');
  assert.equal(options.reasoningEffort, 'high');
  assert.equal(options.tools, 'Read,Bash');
  assert.equal(options.jsonSchema, null);
  assert.deepEqual(options.debugLog, { kind: 'off' });
  assert.equal(options.streaming, false);
  assert.equal(options.verbose, false);
  assert.deepEqual(options.backendArgs, []);
  assert.equal(options.promptArg, 'hello world');
  assert.match(options.turnId, /^[0-9a-f-]{36}$/);
});

test('parses debug log as default log request without consuming prompt text', () => {
  const options = parseCliArgs(['--debug-log', 'hello']);

  assert.deepEqual(options.debugLog, { kind: 'default' });
  assert.equal(options.promptArg, 'hello');
});

test('parses debug log without a path after other options', () => {
  const options = parseCliArgs(['--timeout', '0', '--debug-log']);

  assert.equal(options.timeoutMs, 0);
  assert.deepEqual(options.debugLog, { kind: 'default' });
  assert.equal(options.promptArg, null);
});

test('rejects removed debug log path forms', () => {
  assert.throws(
    () => parseCliArgs(['--debug-log=']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
  assert.throws(
    () => parseCliArgs(['--debug-log=/tmp/openp-debug.jsonl']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('treats dash-prefixed token after debug log as another option', () => {
  assert.throws(
    () => parseCliArgs(['--debug-log', '-dash-starts-path', 'hello']),
    /unsupported option: -dash-starts-path/,
  );
});

test('pre-scans debug log option for parse-time failures', () => {
  assert.deepEqual(parseDebugLogOption(['--debug-log', '--badopt']), { kind: 'default' });
  assert.deepEqual(parseDebugLogOption(['--debug-log=/tmp/openp-debug.jsonl', '--badopt']), { kind: 'off' });
  assert.deepEqual(parseDebugLogOption(['--debug-log=']), { kind: 'off' });
  assert.deepEqual(parseDebugLogOption(['--model', 'haiku', '--debug-log', 'hello']), { kind: 'default' });
});

test('parses verbose as an open-p diagnostic option', () => {
  const options = parseCliArgs(['--verbose', 'hello']);

  assert.equal(options.verbose, true);
  assert.deepEqual(options.backendArgs, []);
  assert.equal(options.promptArg, 'hello');
});

test('pre-scans verbose option for parse-time failures', () => {
  assert.equal(parseVerboseOption(['--verbose', '--badopt']), true);
  assert.equal(parseVerboseOption(['--model', 'haiku', '--verbose']), true);
  assert.equal(parseVerboseOption(['--', '--verbose']), false);
  assert.equal(parseVerboseOption(['hello']), false);
});

test('rejects caller-selected first-turn session ids', () => {
  assert.throws(
    () => parseCliArgs(['--session-id', '11111111-1111-4111-8111-111111111111', 'hello']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('defaults turn timeout to disabled', () => {
  const options = parseCliArgs(['hello']);

  assert.equal(options.timeoutMs, 0);
});

test('accepts backend as first positional subcommand', () => {
  const known = new Set(['claude', 'codex']);
  const options = parseCliArgs(['claude', 'hello', 'world'], known);
  assert.equal(options.backend, 'claude');
  assert.equal(options.promptArg, 'hello world');
});

test('accepts public options before backend subcommand', () => {
  const known = new Set(['claude', 'codex']);
  const options = parseCliArgs(['--debug-log', '--output-format', 'json', 'claude', 'hello'], known);

  assert.equal(options.backend, 'claude');
  assert.deepEqual(options.debugLog, { kind: 'default' });
  assert.equal(options.outputFormat, 'json');
  assert.equal(options.promptArg, 'hello');
});

test('rejects backend option because backend is selected by positional subcommand', () => {
  assert.throws(
    () => parseCliArgs(['--backend', 'claude', 'hello'], new Set(['claude'])),
    /unsupported option: --backend/,
  );
});

test('rejects provider option because provider is not a public CLI option', () => {
  assert.throws(
    () => parseCliArgs(['--provider', 'screen', 'hello']),
    /unsupported option: --provider/,
  );
});

test('rejects unknown first positional when knownBackends provided', () => {
  const known = new Set(['claude']);
  assert.throws(
    () => parseCliArgs(['unknown-thing', 'hello'], known),
    /unknown backend: unknown-thing/,
  );
});

test('requires backend when knownBackends provided and no subcommand', () => {
  const known = new Set(['claude']);
  assert.throws(
    () => parseCliArgs(['--model', 'haiku'], known),
    /backend is required/,
  );
});

test('backend-like option after -- separator remains prompt text', () => {
  const known = new Set(['claude']);
  const options = parseCliArgs(['claude', 'hello', '--', '--backend', 'codex'], known);
  assert.equal(options.backend, 'claude');
  assert.equal(options.promptArg, 'hello --backend codex');
});

test('defaults to claude when knownBackends not provided', () => {
  const options = parseCliArgs(['hello']);
  assert.equal(options.backend, 'claude');
});

test('rejects unsupported options explicitly', () => {
  assert.throws(
    () => parseCliArgs(['--output-format', 'xml', 'hello']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('rejects missing reasoning effort value', () => {
  assert.throws(
    () => parseCliArgs(['--effort']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.usage,
  );
});

test('parses public tool allowlist including empty disable-all value', () => {
  assert.equal(parseCliArgs(['--tools', 'Read,Grep', 'hello']).tools, 'Read,Grep');
  assert.equal(parseCliArgs(['--tools', '', 'hello']).tools, '');
  assert.throws(
    () => parseCliArgs(['--tools']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.usage,
  );
});

test('parses structured output formats explicitly', () => {
  const schema = '{"type":"object"}';
  const options = parseCliArgs(['--output-format', 'json', '--json-schema', schema, 'hello']);
  const streamOptions = parseCliArgs(['--output-format', 'stream-json', '--streaming', 'hello']);

  assert.equal(options.outputFormat, 'json');
  assert.equal(options.jsonSchema, schema);
  assert.equal(options.promptArg, 'hello');
  assert.equal(streamOptions.outputFormat, 'stream-json');
  assert.equal(streamOptions.streaming, true);
  assert.equal(streamOptions.promptArg, 'hello');
  assert.deepEqual(streamOptions.backendArgs, []);
});

test('parses streaming together with structured output because streaming and result are separate', () => {
  const schema = '{"type":"object"}';
  const options = parseCliArgs(['--output-format', 'stream-json', '--streaming', '--json-schema', schema, 'hello']);

  assert.equal(options.outputFormat, 'stream-json');
  assert.equal(options.streaming, true);
  assert.equal(options.jsonSchema, schema);
});

test('rejects raw Claude system prompt options as public openp options', () => {
  assert.throws(
    () => parseCliArgs(['--system-prompt', 'system replacement', 'hello']),
    /unsupported option: --system-prompt/,
  );
  assert.throws(
    () => parseCliArgs(['--append-system-prompt', 'extra rules', 'hello']),
    /unsupported option: --append-system-prompt/,
  );
});

test('rejects malformed json schema before launching backend', () => {
  assert.throws(
    () => parseCliArgs(['--json-schema', 'not-json', 'hello']),
    /--json-schema requires a JSON object/,
  );
  assert.throws(
    () => parseCliArgs(['--streaming', 'hello']),
    /--streaming requires --output-format stream-json/,
  );
  assert.throws(
    () => parseCliArgs(['--include-partial-messages', 'hello']),
    /unsupported option: --include-partial-messages/,
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

test('rejects removed -p flag', () => {
  assert.throws(
    () => parseCliArgs(['-p', 'hello']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('parses command-shim Claude adapter command shape without Claude-only passthrough', () => {
  const schema = '{"type":"object","properties":{"status":{"enum":["pass","fail"]}},"required":["status"]}';
  const options = parseCliArgs([
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--json-schema',
    schema,
  ]);

  assert.equal(options.promptArg, null);
  assert.equal(options.outputFormat, 'stream-json');
  assert.equal(options.permissionMode, 'danger-full-access');
  assert.equal(options.jsonSchema, schema);
  assert.deepEqual(options.backendArgs, []);
});

test('rejects removed Claude-only pass-through flags', () => {
  const valueFlags = [
    '--allowedTools',
    '--allowed-tools',
    '--disallowedTools',
    '--disallowed-tools',
    '--mcp-config',
    '--settings',
    '--setting-sources',
    '--add-dir',
    '--permission-mode',
  ];
  for (const flag of valueFlags) {
    assert.throws(
      () => parseCliArgs([flag, 'value', 'hello']),
      new RegExp(`unsupported option: ${flag}`),
    );
  }

  for (const flag of ['--allow-dangerously-skip-permissions', '--brief']) {
    assert.throws(
      () => parseCliArgs([flag, 'hello']),
      new RegExp(`unsupported option: ${flag}`),
    );
  }
});

test('rejects path-unsafe resume ids before they are used as state paths', () => {
  assert.throws(
    () => parseCliArgs(['--resume', '../outside', 'hello']),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.usage,
  );
});

test('accepts opaque resume ids generated by backends', () => {
  const options = parseCliArgs(['--resume', 'agent-session_01:opaque', 'hello']);

  assert.equal(options.resume, true);
  assert.equal(options.backendSessionId, 'agent-session_01:opaque');
});
