import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCodeArgs, requireLocalModel } from '../../src/backends/opencode/args.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';

test('buildOpenCodeArgs builds a first-turn local-private run command', () => {
  const args = buildOpenCodeArgs({
    message: 'hello',
    sessionId: null,
    isFirstTurn: true,
    options: {
      model: 'ollama/qwen-coder',
      reasoningEffort: null,
      executionMode: null,
      tools: null,
      jsonSchema: null,
      backendArgs: [],
    },
  });
  assert.deepEqual(args, ['run', '--pure', '--format', 'json', '--model', 'ollama/qwen-coder', '--', 'hello']);
});

// `opencode run` takes the message as a positional, so a dash-leading prompt is parsed as a native
// flag unless option parsing is ended first. `--dangerously-skip-permissions` is a real opencode
// option: without the separator a prompt carrying that text runs the turn with permissions the
// caller never requested.
test('buildOpenCodeArgs keeps a dash-leading prompt out of option position', () => {
  const args = buildOpenCodeArgs({
    message: '--dangerously-skip-permissions',
    sessionId: null,
    isFirstTurn: true,
    options: {
      model: 'ollama/qwen-coder',
      reasoningEffort: null,
      executionMode: null,
      tools: null,
      jsonSchema: null,
      backendArgs: [],
    },
  });

  const separator = args.indexOf('--');
  assert.notEqual(separator, -1, 'option parsing is terminated before the prompt');
  assert.equal(args[separator + 1], '--dangerously-skip-permissions', 'prompt is the message positional');
  assert.equal(args.length, separator + 2, 'nothing follows the prompt');
  assert.deepEqual(
    args.slice(0, separator).filter((arg) => arg === '--dangerously-skip-permissions'),
    [],
    'the prompt text never appears in option position',
  );
});

test('buildOpenCodeArgs resumes with a safe session id', () => {
  const args = buildOpenCodeArgs({
    message: 'next',
    sessionId: 'ses_abc123',
    isFirstTurn: false,
    options: {
      model: 'lmstudio/local-model',
      reasoningEffort: 'high',
      executionMode: 'danger-full-access',
      tools: null,
      jsonSchema: null,
      backendArgs: [],
    },
  });
  assert.deepEqual(args, [
    'run',
    '--pure',
    '--format',
    'json',
    '--model',
    'lmstudio/local-model',
    '--session',
    'ses_abc123',
    '--variant',
    'high',
    '--dangerously-skip-permissions',
    '--',
    'next',
  ]);
});

test('buildOpenCodeArgs passes arbitrary non-empty effort values to OpenCode without normalization', () => {
  const args = buildOpenCodeArgs({
    message: 'hello',
    sessionId: null,
    isFirstTurn: true,
    options: {
      model: 'ollama/qwen-coder',
      reasoningEffort: ' future-effort ',
      executionMode: null,
      tools: null,
      jsonSchema: null,
      backendArgs: [],
    },
  });

  assert.deepEqual(args.slice(-4), ['--variant', ' future-effort ', '--', 'hello']);
});

test('requireLocalModel rejects non-local provider prefixes', () => {
  assert.throws(
    () => requireLocalModel('openai/gpt-5'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('requireLocalModel accepts MLX local provider prefixes', () => {
  const model = requireLocalModel('mlx-lm/default_model');
  assert.equal(model.model, 'mlx-lm/default_model');
  assert.equal(model.provider, 'mlx-lm');
  assert.equal(model.modelId, 'default_model');
  assert.equal(model.providerConfig.baseURL, 'http://localhost:8091/v1');
});

test('requireLocalModel rejects ambiguous mlx provider id', () => {
  assert.throws(
    () => requireLocalModel('mlx/default_model'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('requireLocalModel accepts configured OpenCode local provider ids', () => {
  assert.equal(requireLocalModel('lmstudio/google/gemma-3n-e4b').provider, 'lmstudio');
  assert.equal(requireLocalModel('ollama/qwen-coder').provider, 'ollama');
  assert.equal(requireLocalModel('llama.cpp/qwen3-coder:a3b').provider, 'llama.cpp');
});

test('buildOpenCodeArgs rejects unsupported options instead of falling back', () => {
  assert.throws(
    () => buildOpenCodeArgs({
      message: 'hello',
      sessionId: null,
      isFirstTurn: true,
      options: {
        model: 'ollama/qwen-coder',
        reasoningEffort: null,
        executionMode: null,
        tools: 'read,edit',
        jsonSchema: null,
        backendArgs: [],
      },
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('buildOpenCodeArgs rejects an empty --tools value (not silently ignored)', () => {
  assert.throws(
    () => buildOpenCodeArgs({
      message: 'hello',
      sessionId: null,
      isFirstTurn: true,
      options: {
        model: 'ollama/qwen-coder',
        reasoningEffort: null,
        executionMode: null,
        tools: '',
        jsonSchema: null,
        backendArgs: [],
      },
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});

test('buildOpenCodeArgs rejects a native permission mode instead of ignoring it', () => {
  // OpenCode's CLI carries one boolean; its permission model lives in the caller's config files and
  // in OPENCODE_PERMISSION, neither of which open-p writes. Accepting the option and dropping it
  // would run the turn on whatever OpenCode defaults to while the caller believes it was restricted.
  assert.throws(
    () => buildOpenCodeArgs({
      message: 'hello',
      sessionId: null,
      isFirstTurn: true,
      options: {
        model: 'ollama/qwen-coder',
        reasoningEffort: null,
        executionMode: null,
        nativeExecutionMode: 'fixture-mode-alpha',
        tools: null,
        jsonSchema: null,
        backendArgs: [],
      },
    } as Parameters<typeof buildOpenCodeArgs>[0]),
    (error: unknown) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
});
