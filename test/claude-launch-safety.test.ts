import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV,
  withClaudeCodeAccountLaunchEnv,
  withClaudeCodeSafeLaunchEnv,
} from '../src/backends/claude/launch-safety.js';

test('Claude Code safe launch env injects resume modal suppression thresholds', () => {
  const env = withClaudeCodeSafeLaunchEnv({
    CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '70',
    CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '100000',
  });

  assert.equal(
    env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES,
    CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES,
  );
  assert.equal(
    env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD,
    CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD,
  );
});

// The single-turn, persistent, and worker launch paths all call these env builders with an empty
// ambient env (e.g. adapter passes withClaudeCodeAccountLaunchEnv({}, configDir)), so the empty-input
// case is the actual production input — assert the thresholds are injected even with no ambient value.
test('Claude Code launch env injects resume modal suppression thresholds with no ambient env', () => {
  for (const env of [
    withClaudeCodeSafeLaunchEnv(),
    withClaudeCodeAccountLaunchEnv({}, '/tmp/openp-claude-config'),
  ]) {
    assert.equal(
      env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES,
      CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES,
    );
    assert.equal(
      env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD,
      CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD,
    );
  }
});

test('Claude Code account launch env preserves resume modal suppression thresholds', () => {
  const env = withClaudeCodeAccountLaunchEnv(
    {
      CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '70',
      CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '100000',
    },
    '/tmp/openp-claude-config',
  );

  assert.equal(
    env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES,
    CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES,
  );
  assert.equal(
    env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD,
    CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD,
  );
});
