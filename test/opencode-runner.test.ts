import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runOpenCodeTurn } from '../src/backends/opencode/runner.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

test('runOpenCodeTurn preserves non-JSON stdout and stderr diagnostics on non-zero exit', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-error-'));
  const bin = new URL('./fixtures/opencode/fake-opencode-error.mjs', import.meta.url).pathname;

  await assert.rejects(
    runOpenCodeTurn({
      message: 'hello',
      sessionId: null,
      isFirstTurn: true,
      projectRoot,
      model: 'ollama/qwen-coder',
      reasoningEffort: 'future-effort',
      executionMode: null,
      tools: null,
      jsonSchema: null,
      backendArgs: [],
      timeoutMs: 5_000,
      bin,
      env: { ...process.env, XDG_STATE_HOME: join(projectRoot, 'state') },
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendExited &&
      error.message.includes('OpenCode CLI exited with code 9') &&
      error.message.includes('raw stdout diagnostic') &&
      error.message.includes('stderr diagnostic'),
  );
});
