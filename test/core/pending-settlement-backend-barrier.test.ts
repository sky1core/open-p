import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeCodeBackend } from '../../src/backends/claude/adapter.js';
import { CodexBackend } from '../../src/backends/codex/backend.js';
import { KiroBackend } from '../../src/backends/kiro/backend.js';
import { OpenCodeBackend } from '../../src/backends/opencode/backend.js';
import type { Backend } from '../../src/core/backend.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';
import { SessionLockStore } from '../../src/core/session-lock.js';
import type { BackendRunOptions } from '../../src/core/types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

test('every direct backend invokes pending settlement under the session lock before native launch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-pending-backend-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-pending-backend-state-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const backends: readonly [string, Backend][] = [
    ['claude', new ClaudeCodeBackend({} as never)],
    ['codex', new CodexBackend()],
    ['kiro', new KiroBackend()],
    ['opencode', new OpenCodeBackend()],
  ];
  try {
    for (const [name, backend] of backends) {
      let settlementCalls = 0;
      const injected = new OpenPError(`${name} settlement stopped launch`, EXIT_CODES.protocolViolation);
      const options: BackendRunOptions = {
        cwd,
        backendSessionId: SESSION_ID,
        resume: true,
        timeoutMs: 0,
        model: null,
        reasoningEffort: null,
        permissionMode: null,
        nativePermissionMode: null,
        tools: null,
        jsonSchema: null,
        backendArgs: [],
        debugLog: null,
        settlePendingSeedAppend: async () => {
          settlementCalls += 1;
          await assert.rejects(
            () => new SessionLockStore(cwd).acquire(SESSION_ID),
            (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
          );
          throw injected;
        },
      };

      await assert.rejects(
        () => backend.runTurn({ turnId: `${name}-turn`, prompt: 'must not launch' }, options),
        (error) => error === injected,
      );
      assert.equal(settlementCalls, 1);
      const released = await new SessionLockStore(cwd).acquire(SESSION_ID);
      await released.release();
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test('every direct backend fails closed before native launch when resume settlement is not wired', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-missing-pending-backend-cwd-'));
  const stateHome = await mkdtemp(join(tmpdir(), 'openp-missing-pending-backend-state-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const backends: readonly [string, Backend][] = [
    ['claude', new ClaudeCodeBackend({} as never)],
    ['codex', new CodexBackend()],
    ['kiro', new KiroBackend()],
    ['opencode', new OpenCodeBackend()],
  ];
  try {
    for (const [name, backend] of backends) {
      const options: BackendRunOptions = {
        cwd,
        backendSessionId: SESSION_ID,
        resume: true,
        timeoutMs: 0,
        model: null,
        reasoningEffort: null,
        permissionMode: null,
        nativePermissionMode: null,
        tools: null,
        jsonSchema: null,
        backendArgs: [],
        debugLog: null,
      };

      await assert.rejects(
        () => backend.runTurn({ turnId: `${name}-turn`, prompt: 'must not launch' }, options),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation &&
          error.message.includes('requires pending seed settlement'),
      );
      const released = await new SessionLockStore(cwd).acquire(SESSION_ID);
      await released.release();
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});
