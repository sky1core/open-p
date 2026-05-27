import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';

test('default state root is outside the target project tree', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-workspace-'));
  const stateRoot = resolveOpenPStateRoot(projectRoot, {});

  assert.equal(stateRoot.startsWith(projectRoot), false);
  assert.match(stateRoot, /open-p\/workspaces\/[0-9a-f]{32}$/);
});

test('XDG_STATE_HOME supplies the standard state base while keeping workspace namespacing', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-workspace-'));
  const baseStateRoot = await mkdtemp(join(tmpdir(), 'openp-state-base-'));
  const stateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: baseStateRoot });

  assert.equal(stateRoot.startsWith(baseStateRoot), true);
  assert.match(stateRoot, /open-p\/workspaces\/[0-9a-f]{32}$/);
});
