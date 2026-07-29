import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { requireLocalModel } from '../../src/backends/opencode/args.js';
import { runOpenCodeTurn } from '../../src/backends/opencode/runner.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';

const TEST_MODEL = 'mlx-lm/artificial-model';
const CHILD_STARTED_MARKER = 'opencode-child-started.marker';

test('runOpenCodeTurn fails before spawning OpenCode when local provider endpoint is unreachable', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-preflight-fail-'));
  const bin = new URL('./fake-opencode-success.mjs', import.meta.url).pathname;
  const port = await reserveUnusedLoopbackPort(t);
  if (port === null) return;

  await withOpenCodeProviderBaseURL(`http://127.0.0.1:${port}/v1`, async () => {
    await assert.rejects(
      runOpenCodeTurn({
        message: 'hello',
        sessionId: null,
        isFirstTurn: true,
        projectRoot,
        model: TEST_MODEL,
        reasoningEffort: null,
        executionMode: null,
        tools: null,
        jsonSchema: null,
        backendArgs: [],
        timeoutMs: 0,
        bin,
        env: { ...process.env, XDG_STATE_HOME: join(projectRoot, 'state') },
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendStartFailed &&
        error.message.includes(`http://127.0.0.1:${port}/v1`),
    );
  });

  // An unreachable provider endpoint puts the OpenCode child into a connection retry loop that does
  // not stop on its own and never reaches stdout, so the failure only stays bounded while the check
  // runs before the child starts. The marker the fake binary writes on startup is therefore the
  // assertion that keeps the check in that position.
  assert.equal(existsSync(join(projectRoot, CHILD_STARTED_MARKER)), false);
});

test('runOpenCodeTurn proceeds to OpenCode when local provider endpoint accepts TCP connections', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-preflight-pass-'));
  const bin = new URL('./fake-opencode-success.mjs', import.meta.url).pathname;
  const server = await startLoopbackServer(t);
  if (server === null) return;

  try {
    await withOpenCodeProviderBaseURL(`http://127.0.0.1:${server.port}/v1`, async () => {
      const result = await runOpenCodeTurn({
        message: 'hello',
        sessionId: null,
        isFirstTurn: true,
        projectRoot,
        model: TEST_MODEL,
        reasoningEffort: null,
        executionMode: null,
        tools: null,
        jsonSchema: null,
        backendArgs: [],
        timeoutMs: 5_000,
        bin,
        env: { ...process.env, XDG_STATE_HOME: join(projectRoot, 'state') },
      });

      assert.equal(result.content, 'fake success');
      assert.equal(result.sessionId, 'ses_fake_success');
      // Counterpart to the unreachable-endpoint assertion: the marker does appear once the child
      // is allowed to start, so its absence there means the child never ran.
      assert.equal(existsSync(join(projectRoot, CHILD_STARTED_MARKER)), true);
    });
  } finally {
    await server.close();
  }
});

test('runOpenCodeTurn preserves non-JSON stdout and stderr diagnostics on non-zero exit', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-error-'));
  const bin = new URL('./fake-opencode-error.mjs', import.meta.url).pathname;
  const server = await startLoopbackServer(t);
  if (server === null) return;

  try {
    await withOpenCodeProviderBaseURL(`http://127.0.0.1:${server.port}/v1`, async () => {
      await assert.rejects(
        runOpenCodeTurn({
          message: 'hello',
          sessionId: null,
          isFirstTurn: true,
          projectRoot,
          model: TEST_MODEL,
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
  } finally {
    await server.close();
  }
});

async function withOpenCodeProviderBaseURL<T>(baseURL: string, run: () => Promise<T>): Promise<T> {
  const providerConfig = requireLocalModel(TEST_MODEL).providerConfig as { baseURL: string };
  const previousBaseURL = providerConfig.baseURL;
  providerConfig.baseURL = baseURL;
  try {
    return await run();
  } finally {
    providerConfig.baseURL = previousBaseURL;
  }
}

async function reserveUnusedLoopbackPort(t: TestContext): Promise<number | null> {
  const server = await startLoopbackServer(t);
  if (server === null) return null;
  const port = server.port;
  await server.close();
  return port;
}

interface LoopbackServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function startLoopbackServer(t: TestContext): Promise<LoopbackServer | null> {
  const server = net.createServer((socket) => {
    socket.end();
  });
  const port = await new Promise<number | null>((resolve, reject) => {
    server.once('error', (error) => {
      if (isErrorCode(error, 'EPERM')) {
        t.skip('loopback TCP listen is not permitted in this test environment');
        resolve(null);
        return;
      }
      reject(error);
    });
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!isAddressInfo(address)) {
        reject(new Error('loopback test server did not expose a TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
  if (port === null) {
    return null;
  }
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === 'object' && address !== null;
}
