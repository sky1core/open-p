import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeCodeBackend } from '../../src/backends/claude/adapter.js';
import {
  isClaudeCodeEmptyInputReady,
  isClaudeCodeSelectionPromptError,
  readClaudeCodeSelectionPromptScreen,
  waitForClaudeCodeInputReady,
} from '../../src/backends/claude/interactive.js';
import {
  startPersistentClaudeCodeProcess,
  type PersistentClaudeCodeProcess,
} from '../../src/backends/claude/persistent-process.js';
import {
  captureClaudeInputDraftSurface,
} from '../../src/backends/claude/submission-recovery.js';
import {
  createClaudeCodeSessionLogWaitState,
  inspectClaudeCodeCallerUserTurnInSessionLogSegment,
  recordClaudeCodeSessionLogProgress,
  resolveClaudeCodeProjectLogDir,
  waitForClaudeCodeTurnResult,
} from '../../src/backends/claude/session-log.js';
import { buildLaunchSignature } from '../../src/core/launch-signature.js';
import {
  ARTIFACT_REJECTION_REASONS,
  EXIT_CODES,
  OpenPError,
} from '../../src/core/errors.js';
import { SessionStateStore } from '../../src/core/session-state.js';
import type { PtyProvider, PtySession } from '../../src/runners/types.js';

const SYNTHETIC_SESSION_ID = '00000000-0000-4000-8000-000000000111';
const SYNTHETIC_TURN_ID = '00000000-0000-4000-8000-000000000222';
const SYNTHETIC_PROMPT = 'SYNTHETIC CALLER PROMPT';
const SYNTHETIC_RESULT = 'SYNTHETIC ASSISTANT RESULT';
const SYNTHETIC_MENU_LINE = '❯ 1. SYNTHETIC HUMAN CHOICE';

test('single-turn resume delivers the caller prompt without scanning stale screen text', async () => {
  await withSyntheticClaudeEnvironment('adapter-resume', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'complete',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    const result = await backend.runTurn(
      {
        turnId: SYNTHETIC_TURN_ID,
        prompt: SYNTHETIC_PROMPT,
        jsonSchema: null,
      },
      adapterResumeOptions(environment.cwd),
    );

    assert.equal(result.text, SYNTHETIC_RESULT);
    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 1);
    assert.equal(session.captureTextCount, 0);
  });
});

test('persistent resume delivers the caller prompt without scanning stale screen text', async () => {
  await withSyntheticClaudeEnvironment('persistent-resume', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'complete',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      const result = await process.sendTurn(SYNTHETIC_PROMPT, {
        timeoutMs: 0,
        debugLog: null,
        jsonSchema: null,
      });

      assert.equal(result.text, SYNTHETIC_RESULT);
      assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
      assert.equal(session.submitCount, 1);
      assert.equal(session.captureTextCount, 0);
    } finally {
      await process.shutdown();
    }
  });
});

test('single-turn resume waits for a delayed draft render before submitting', async () => {
  await withSyntheticClaudeEnvironment('adapter-delayed-draft-render', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'delayed-draft-render',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    const result = await backend.runTurn(
      {
        turnId: SYNTHETIC_TURN_ID,
        prompt: SYNTHETIC_PROMPT,
        jsonSchema: null,
      },
      adapterResumeOptions(environment.cwd),
    );

    assert.equal(result.text, SYNTHETIC_RESULT);
    assert.equal(session.submitCount, 1);
    assert.equal(session.draftCaptureCount > 16, true);
  });
});

test('single-turn post-write failure terminates without input and preserves the transport error', async () => {
  await withSyntheticClaudeEnvironment('adapter-partial-write-failure', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'write-throws-after-partial',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        adapterResumeOptions(environment.cwd),
      ),
      (error) => error instanceof Error && error.message === 'synthetic partial write failure',
    );

    assert.equal(session.submitCount, 0);
    assert.equal(session.terminateCount, 1);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent post-write failure terminates without input and preserves the transport error', async () => {
  await withSyntheticClaudeEnvironment('persistent-partial-write-failure', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'write-throws-after-partial',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 0,
          debugLog: null,
          jsonSchema: null,
        }),
        (error) => error instanceof Error && error.message === 'synthetic partial write failure',
      );
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 0);
    assert.equal(session.terminateCount, 1);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn does not write into a selection menu that appears immediately before write', async () => {
  await withSyntheticClaudeEnvironment('adapter-pre-write-selection', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'menu-before-write',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        adapterResumeOptions(environment.cwd),
      ),
      isClaudeCodeSelectionPromptError,
    );

    assert.deepEqual(session.writes, []);
    assert.equal(session.submitCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent process does not write into a selection menu that appears immediately before write', async () => {
  await withSyntheticClaudeEnvironment('persistent-pre-write-selection', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'menu-before-write',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 0,
          debugLog: null,
          jsonSchema: null,
        }),
        isSelectionPromptFailure,
      );
    } finally {
      await process.shutdown();
    }

    assert.deepEqual(session.writes, []);
    assert.equal(session.submitCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn post-write abort settles force-only shutdown before surfacing AbortError', async () => {
  await withSyntheticClaudeEnvironment('adapter-post-write-abort', async (environment) => {
    const controller = new AbortController();
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'complete',
      () => controller.abort(),
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        {
          ...adapterResumeOptions(environment.cwd),
          signal: controller.signal,
        },
      ),
      (error) => error instanceof Error && error.name === 'AbortError',
    );

    assert.equal(session.submitCount, 0);
    assert.equal(session.interruptCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent post-write abort settles force-only shutdown before surfacing AbortError', async () => {
  await withSyntheticClaudeEnvironment('persistent-post-write-abort', async (environment) => {
    const controller = new AbortController();
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'complete',
      () => controller.abort(),
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 0,
          debugLog: null,
          jsonSchema: null,
          signal: controller.signal,
        }),
        (error) => error instanceof Error && error.name === 'AbortError',
      );
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 0);
    assert.equal(session.interruptCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn abort during pre-write surface capture does not write caller bytes', async () => {
  await withSyntheticClaudeEnvironment('adapter-pre-write-surface-abort', async (environment) => {
    const controller = new AbortController();
    const session = new AbortDuringSurfaceCaptureSession(
      environment.logPath,
      environment.cwd,
      controller,
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        {
          ...adapterResumeOptions(environment.cwd),
          signal: controller.signal,
        },
      ),
      (error) => error instanceof Error && error.name === 'AbortError',
    );

    assert.deepEqual(session.writes, []);
    assert.equal(session.submitCount, 0);
  });
});

test('persistent deadline during pre-write surface capture does not write caller bytes', async () => {
  await withSyntheticClaudeEnvironment('persistent-pre-write-surface-timeout', async (environment) => {
    const session = new DelayedSurfaceCaptureSession(
      environment.logPath,
      environment.cwd,
      1_200,
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 1_000,
          debugLog: null,
          jsonSchema: null,
        }),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
      );
    } finally {
      await process.shutdown();
    }

    assert.deepEqual(session.writes, []);
    assert.equal(session.submitCount, 0);
  });
});

test('single-turn does not submit a changed status row as the written caller draft', async () => {
  await withSyntheticClaudeEnvironment('adapter-status-row-after-write', async (environment) => {
    const session = new StatusRowAfterWriteSession(
      environment.logPath,
      environment.cwd,
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        { ...adapterResumeOptions(environment.cwd), timeoutMs: 8_000 },
      ),
      isPromptNotExecutedFailure,
    );

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 0);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn submits once after production cursor capabilities prove the written draft', async () => {
  await withSyntheticClaudeEnvironment('adapter-editable-draft-after-write', async (environment) => {
    const session = new EditableDraftAfterWriteSession(
      environment.logPath,
      environment.cwd,
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    const result = await backend.runTurn(
      {
        turnId: SYNTHETIC_TURN_ID,
        prompt: SYNTHETIC_PROMPT,
        jsonSchema: null,
      },
      adapterResumeOptions(environment.cwd),
    );

    assert.equal(result.text, SYNTHETIC_RESULT);
    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 1);
    assert.equal(session.moveStartCount, 2);
    assert.equal(session.moveEndCount >= 4, true);
  });
});

test('persistent process submits once after production cursor capabilities prove the written draft', async () => {
  await withSyntheticClaudeEnvironment('persistent-editable-draft-after-write', async (environment) => {
    const session = new EditableDraftAfterWriteSession(
      environment.logPath,
      environment.cwd,
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      const result = await process.sendTurn(SYNTHETIC_PROMPT, {
        timeoutMs: 0,
        debugLog: null,
        jsonSchema: null,
      });

      assert.equal(result.text, SYNTHETIC_RESULT);
      assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
      assert.equal(session.submitCount, 1);
      assert.equal(session.moveStartCount, 2);
      assert.equal(session.moveEndCount >= 4, true);
    } finally {
      await process.shutdown();
    }
  });
});

test('abort preserves missing-boundary downgrade when caller appears during shutdown', async () => {
  await withSyntheticClaudeEnvironment('adapter-abort-caller-during-shutdown', async (environment) => {
    const controller = new AbortController();
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'caller-during-shutdown',
      () => controller.abort(),
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        {
          ...adapterResumeOptions(environment.cwd),
          signal: controller.signal,
        },
      ),
      isMissingTurnBoundaryFailure,
    );
  });
});

test('single-turn post-write timeout finishes force-only shutdown before cleanup', async () => {
  await withSyntheticClaudeEnvironment('adapter-post-write-timeout', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'drop-to-empty-input',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        {
          ...adapterResumeOptions(environment.cwd),
          timeoutMs: 1_000,
        },
      ),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
    );

    assert.equal(session.submitCount, 1);
    assert.equal(session.interruptCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent post-write timeout finishes force-only shutdown before cleanup', async () => {
  await withSyntheticClaudeEnvironment('persistent-post-write-timeout', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'drop-to-empty-input',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 1_000,
          debugLog: null,
          jsonSchema: null,
        }),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
      );
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 1);
    assert.equal(session.interruptCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn submit resolving after deadline still finishes force-only shutdown', async () => {
  await withSyntheticClaudeEnvironment('adapter-slow-submit-timeout', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'submit-resolves-after-deadline',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        {
          ...adapterResumeOptions(environment.cwd),
          timeoutMs: 1_000,
        },
      ),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
    );

    assert.equal(session.submitCount, 1);
    assert.equal(session.interruptCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent submit resolving after deadline still finishes force-only shutdown', async () => {
  await withSyntheticClaudeEnvironment('persistent-slow-submit-timeout', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'submit-resolves-after-deadline',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 1_000,
          debugLog: null,
          jsonSchema: null,
        }),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
      );
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 1);
    assert.equal(session.interruptCount, 0);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn submit exception with a recorded caller is non-resend-safe', async () => {
  await withSyntheticClaudeEnvironment('adapter-submit-throw', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'submit-throws-after-caller',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        adapterResumeOptions(environment.cwd),
      ),
      isMissingTurnBoundaryFailure,
    );

    assert.equal(session.submitCount, 1);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent submit exception with a recorded caller is non-resend-safe', async () => {
  await withSyntheticClaudeEnvironment('persistent-submit-throw', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'submit-throws-after-caller',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 0,
          debugLog: null,
          jsonSchema: null,
        }),
        isMissingTurnBoundaryFailure,
      );
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 1);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn arbitrary pre-caller wait exception cannot fall back to input cleanup', async () => {
  await withSyntheticClaudeEnvironment('adapter-pre-caller-await-throw', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'is-alive-throws-after-submit',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        adapterResumeOptions(environment.cwd),
      ),
      isMissingTurnBoundaryFailure,
    );

    assert.equal(session.submitCount, 1);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent arbitrary pre-caller wait exception cannot fall back to input cleanup', async () => {
  await withSyntheticClaudeEnvironment('persistent-pre-caller-await-throw', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'is-alive-throws-after-submit',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 0,
          debugLog: null,
          jsonSchema: null,
        }),
        isMissingTurnBoundaryFailure,
      );
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 1);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn recovery submit exception with a recorded caller is non-resend-safe', async () => {
  await withSyntheticClaudeEnvironment('adapter-recovery-submit-throw', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'recovery-submit-throws-after-caller',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        adapterResumeOptions(environment.cwd),
      ),
      isMissingTurnBoundaryFailure,
    );

    assert.equal(session.submitCount, 2);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent recovery submit exception with a recorded caller is non-resend-safe', async () => {
  await withSyntheticClaudeEnvironment('persistent-recovery-submit-throw', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'recovery-submit-throws-after-caller',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 0,
          debugLog: null,
          jsonSchema: null,
        }),
        isMissingTurnBoundaryFailure,
      );
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 2);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('single-turn resume keeps waiting when submission returns to an empty input without a caller turn', async () => {
  await withSyntheticClaudeEnvironment('adapter-dropped-submission', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'drop-to-empty-input',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 8_000);

    try {
      await assert.rejects(
        backend.runTurn(
          {
            turnId: SYNTHETIC_TURN_ID,
            prompt: SYNTHETIC_PROMPT,
            jsonSchema: null,
          },
          {
            ...adapterResumeOptions(environment.cwd),
            signal: controller.signal,
          },
        ),
        (error) => error instanceof Error && error.name === 'AbortError',
      );
    } finally {
      clearTimeout(abortTimer);
    }

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 1);
  });
});

test('single-turn resume fails resend-safe when the draft never renders within the caller budget', async () => {
  await withSyntheticClaudeEnvironment('adapter-no-draft-fingerprint', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'drop-before-draft-render',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        { ...adapterResumeOptions(environment.cwd), timeoutMs: 8_000 },
      ),
      isPromptNotExecutedFailure,
    );

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 0);
  });
});

test('persistent resume fails resend-safe when the draft never renders within the caller budget', async () => {
  await withSyntheticClaudeEnvironment('persistent-dropped-submission', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'drop-before-draft-render',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 8_000,
          debugLog: null,
          jsonSchema: null,
        }),
        isPromptNotExecutedFailure,
      );
    } finally {
      await process.shutdown();
    }

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 0);
  });
});

test('single-turn resume keeps waiting after a recovery submit returns to an empty input', async () => {
  await withSyntheticClaudeEnvironment('adapter-dropped-recovery', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'recovery-drop-to-empty',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 8_000);

    try {
      await assert.rejects(
        backend.runTurn(
          {
            turnId: SYNTHETIC_TURN_ID,
            prompt: SYNTHETIC_PROMPT,
            jsonSchema: null,
          },
          {
            ...adapterResumeOptions(environment.cwd),
            signal: controller.signal,
          },
        ),
        (error) => error instanceof Error && error.name === 'AbortError',
      );
    } finally {
      clearTimeout(abortTimer);
    }

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 2);
  });
});

test('persistent resume keeps waiting after a recovery submit returns to an empty input', async () => {
  await withSyntheticClaudeEnvironment('persistent-dropped-recovery', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'recovery-drop-to-empty',
    );
    const process = await startSyntheticPersistentProcess(environment, session);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 8_000);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 0,
          debugLog: null,
          jsonSchema: null,
          signal: controller.signal,
        }),
        (error) => error instanceof Error && error.name === 'AbortError',
      );
    } finally {
      clearTimeout(abortTimer);
      await process.shutdown();
    }

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 2);
  });
});

test('single-turn does not claim resend safety when a caller turn appears during shutdown', async () => {
  await withSyntheticClaudeEnvironment('adapter-caller-during-shutdown', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'caller-during-shutdown',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        { ...adapterResumeOptions(environment.cwd), timeoutMs: 8_000 },
      ),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.reasonCode === ARTIFACT_REJECTION_REASONS.missingTurnBoundary,
    );

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 1);
  });
});

test('persistent process does not claim resend safety when a caller turn appears during shutdown', async () => {
  await withSyntheticClaudeEnvironment('persistent-caller-during-shutdown', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'caller-during-shutdown',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await assert.rejects(
        process.sendTurn(SYNTHETIC_PROMPT, {
          timeoutMs: 8_000,
          debugLog: null,
          jsonSchema: null,
        }),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          error.reasonCode === ARTIFACT_REJECTION_REASONS.missingTurnBoundary,
      );
    } finally {
      await process.shutdown();
    }

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 1);
  });
});

test('single-turn does not claim resend safety when shutdown leaves a partial caller record', async () => {
  await withSyntheticClaudeEnvironment('adapter-partial-caller-during-shutdown', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'partial-caller-during-shutdown',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        { ...adapterResumeOptions(environment.cwd), timeoutMs: 8_000 },
      ),
      isMissingTurnBoundaryFailure,
    );
  });
});

test('single-turn does not claim resend safety when shutdown leaves a malformed complete record', async () => {
  await withSyntheticClaudeEnvironment('adapter-malformed-record-during-shutdown', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'malformed-record-during-shutdown',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        { ...adapterResumeOptions(environment.cwd), timeoutMs: 8_000 },
      ),
      isMissingTurnBoundaryFailure,
    );
  });
});

test('final caller-boundary inspection accepts blank JSONL separators', async () => {
  await withSyntheticClaudeEnvironment('blank-jsonl-separator', async (environment) => {
    await appendFile(environment.logPath, '\n');

    const inspection = await inspectClaudeCodeCallerUserTurnInSessionLogSegment(
      environment.logPath,
      0,
    );

    assert.equal(inspection.readable, true);
    assert.equal(inspection.sawCallerUserTurn, false);
    assert.equal(inspection.hasIncompleteTail, false);
    assert.equal(inspection.hasMalformedRecord, false);
  });
});

test('final caller-boundary inspection reports a non-file path as unreadable', async () => {
  await withSyntheticClaudeEnvironment('non-file-final-inspection', async (environment) => {
    const inspection = await inspectClaudeCodeCallerUserTurnInSessionLogSegment(
      environment.cwd,
      0,
    );

    assert.equal(inspection.readable, false);
    assert.equal(inspection.sawCallerUserTurn, false);
    assert.equal(inspection.hasIncompleteTail, false);
    assert.equal(inspection.hasMalformedRecord, false);
  });
});

test('re-reading the same incomplete-tail bytes is not new session-log progress', () => {
  const waitState = createClaudeCodeSessionLogWaitState();

  assert.equal(recordClaudeCodeSessionLogProgress(waitState, '/synthetic/session.jsonl', 17), true);
  waitState.selectionPromptStallObservations = 1;
  assert.equal(recordClaudeCodeSessionLogProgress(waitState, '/synthetic/session.jsonl', 17), false);
  assert.equal(waitState.selectionPromptStallObservations, 1);
  assert.equal(recordClaudeCodeSessionLogProgress(waitState, '/synthetic/session.jsonl', 18), true);
});

test('single-turn fresh submission does not claim resend safety without a final log path', async () => {
  await withSyntheticClaudeEnvironment('adapter-fresh-missing-log', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'drop-to-empty-input',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await assert.rejects(
      backend.runTurn(
        {
          turnId: SYNTHETIC_TURN_ID,
          prompt: SYNTHETIC_PROMPT,
          jsonSchema: null,
        },
        {
          ...adapterResumeOptions(environment.cwd),
          resume: false,
          timeoutMs: 8_000,
        },
      ),
      isMissingTurnBoundaryFailure,
    );
  });
});

test('initial input readiness must survive the settle interval', async () => {
  const session = new TransientReadySession();

  await waitForClaudeCodeInputReady(session, 3_000, {
    confirmTrustPrompt: false,
  });

  assert.equal(session.captureCursorLineCount, 4);
});

test('empty input readiness must remain visible before it is terminal evidence', async () => {
  let captureCount = 0;
  const ready = await isClaudeCodeEmptyInputReady({
    async captureCursorLine() {
      captureCount += 1;
      return captureCount === 1 ? '❯' : 'SYNTHETIC WORKING';
    },
  });

  assert.equal(ready, false);
  assert.equal(captureCount, 2);
});

test('non-submitting End probe distinguishes an empty suggestion from a draft at column two', async () => {
  let suggestionEndCount = 0;
  const suggestionReady = await isClaudeCodeEmptyInputReady({
    async captureCursorLine() {
      return '❯\u00a0Try "refactor <filepath>"';
    },
    async captureCursorSurface() {
      return {
        line: '❯\u00a0Try "refactor <filepath>"',
        cursorRow: 20,
        cursorColumn: 2,
      };
    },
    async moveCursorToEnd() {
      suggestionEndCount += 1;
    },
  });
  let draftCursorColumn = 2;
  const draftReady = await isClaudeCodeEmptyInputReady({
    async captureCursorLine() {
      return '❯\u00a0SYNTHETIC CALLER DRAFT';
    },
    async captureCursorSurface() {
      return {
        line: '❯\u00a0SYNTHETIC CALLER DRAFT',
        cursorRow: 20,
        cursorColumn: draftCursorColumn,
      };
    },
    async moveCursorToEnd() {
      setTimeout(() => {
        draftCursorColumn = 24;
      }, 50);
    },
  });

  assert.equal(suggestionReady, true);
  assert.equal(suggestionEndCount, 2);
  assert.equal(draftReady, false);
});

test('cursor-surface capture failure is unreadable', async () => {
  const surface = await captureClaudeInputDraftSurface({
    async captureCursorLine() {
      return '❯\u00a0Try "refactor <filepath>"';
    },
    async captureCursorSurface() {
      throw new Error('cursor moved during capture');
    },
  });

  assert.equal(surface, null);
});

test('single-turn adapter production wiring fails a stalled selection prompt closed', async () => {
  await withSyntheticClaudeEnvironment('adapter-selection', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'stall-on-pre-caller-selection',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await withAcceleratedSelectionStallClock(session, async () => {
      await assert.rejects(
        backend.runTurn(
          {
            turnId: SYNTHETIC_TURN_ID,
            prompt: SYNTHETIC_PROMPT,
            jsonSchema: null,
          },
          adapterResumeOptions(environment.cwd),
        ),
        isSelectionPromptFailure,
      );
    });

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 1);
    assert.equal(session.captureTextCount >= 2, true);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('persistent production wiring fails a stalled selection prompt closed', async () => {
  await withSyntheticClaudeEnvironment('persistent-selection', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'stall-on-selection',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await withAcceleratedSelectionStallClock(session, async () => {
        await assert.rejects(
          process.sendTurn(SYNTHETIC_PROMPT, {
            timeoutMs: 0,
            debugLog: null,
            jsonSchema: null,
          }),
          isSelectionPromptFailure,
        );
      });
    } finally {
      await process.shutdown();
    }

    assert.deepEqual(session.writes, [SYNTHETIC_PROMPT]);
    assert.equal(session.submitCount, 1);
    assert.equal(session.captureTextCount >= 2, true);
    assert.equal(session.terminateCount >= 1, true);
    assert.equal(session.exitWhileAliveCount, 0);
  });
});

test('missing-caller retry resets selection observations after a non-menu recovery reading', async () => {
  await withSyntheticClaudeEnvironment('adapter-intermittent-selection', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'intermittent-pre-caller-selection',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await withAcceleratedSelectionStallClock(session, async () => {
      await assert.rejects(
        backend.runTurn(
          {
            turnId: SYNTHETIC_TURN_ID,
            prompt: SYNTHETIC_PROMPT,
            jsonSchema: null,
          },
          adapterResumeOptions(environment.cwd),
        ),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.backendExited &&
          !/interactive selection prompt/.test(error.message),
      );
    });
  });
});

test('single-turn unreadable recovery capture preserves selection prompt observations', async () => {
  await withSyntheticClaudeEnvironment('adapter-unreadable-recovery-selection', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'selection-with-unreadable-recovery-capture',
    );
    const backend = new ClaudeCodeBackend(new SyntheticProvider(session), {
      configDir: environment.configDir,
    });

    await withAcceleratedSelectionStallClock(session, async () => {
      await assert.rejects(
        backend.runTurn(
          {
            turnId: SYNTHETIC_TURN_ID,
            prompt: SYNTHETIC_PROMPT,
            jsonSchema: null,
          },
          adapterResumeOptions(environment.cwd),
        ),
        isSelectionPromptFailure,
      );
    });

    assert.equal(session.submitCount, 1);
  });
});

test('persistent unreadable recovery capture preserves selection prompt observations', async () => {
  await withSyntheticClaudeEnvironment('persistent-unreadable-recovery-selection', async (environment) => {
    const session = new SyntheticTurnSession(
      environment.logPath,
      environment.cwd,
      'selection-with-unreadable-recovery-capture',
    );
    const process = await startSyntheticPersistentProcess(environment, session);

    try {
      await withAcceleratedSelectionStallClock(session, async () => {
        await assert.rejects(
          process.sendTurn(SYNTHETIC_PROMPT, {
            timeoutMs: 0,
            debugLog: null,
            jsonSchema: null,
          }),
          isSelectionPromptFailure,
        );
      });
    } finally {
      await process.shutdown();
    }

    assert.equal(session.submitCount, 1);
  });
});

test('selection prompt diagnostic remains explicit when screen capture is unavailable', async () => {
  const diagnostic = await readClaudeCodeSelectionPromptScreen({
    async captureCursorLine() {
      return SYNTHETIC_MENU_LINE;
    },
    async captureText() {
      throw new Error('synthetic screen capture failure');
    },
  });

  assert.match(diagnostic ?? '', /screen: unavailable/);
});

test('unbounded log discovery ends on an observed selection prompt, not an internal timeout', async () => {
  await withSyntheticClaudeEnvironment('selection-before-log', async (environment) => {
    const originalDateNow = Date.now;
    let nowMs = 2_000_000;
    Date.now = () => {
      const observed = nowMs;
      nowMs += 300_001;
      return observed;
    };

    try {
      await assert.rejects(
        waitForClaudeCodeTurnResult({
          sessionId: null,
          turnId: SYNTHETIC_TURN_ID,
          timeoutMs: 0,
          initialOffset: 0,
          knownLogPath: null,
          cwd: environment.cwd,
          configDir: environment.configDir,
          discoveryStartedAtMs: 0,
          excludedLogPaths: new Set([environment.logPath]),
          isBackendAlive: async () => true,
          readBackendSelectionPromptScreen: async () =>
            `\nLast Claude Code screen:\n${SYNTHETIC_MENU_LINE}`,
        }),
        isSelectionPromptFailure,
      );
    } finally {
      Date.now = originalDateNow;
    }
  });
});

type SyntheticTurnOutcome =
  | 'caller-during-shutdown'
  | 'complete'
  | 'delayed-draft-render'
  | 'drop-before-draft-render'
  | 'drop-to-empty-input'
  | 'intermittent-pre-caller-selection'
  | 'is-alive-throws-after-submit'
  | 'malformed-record-during-shutdown'
  | 'menu-before-write'
  | 'partial-caller-during-shutdown'
  | 'recovery-submit-throws-after-caller'
  | 'recovery-drop-to-empty'
  | 'selection-with-unreadable-recovery-capture'
  | 'stall-on-pre-caller-selection'
  | 'stall-on-selection'
  | 'submit-resolves-after-deadline'
  | 'submit-throws-after-caller'
  | 'write-throws-after-partial';

class SyntheticTurnSession implements PtySession {
  readonly id = 'synthetic-pty-session';
  readonly writes: string[] = [];
  submitCount = 0;
  captureTextCount = 0;
  draftCaptureCount = 0;
  terminateCount = 0;
  interruptCount = 0;
  exitWhileAliveCount = 0;
  submitted = false;
  private alive = true;
  private draft: string | null = null;
  private preSubmitCaptureCount = 0;
  private postSubmitCaptureCount = 0;

  constructor(
    private readonly logPath: string,
    private readonly cwd: string,
    private readonly outcome: SyntheticTurnOutcome,
    private readonly onWriteAttempted?: () => void,
  ) {}

  async write(input: string): Promise<void> {
    this.writes.push(input);
    this.draft = input;
    this.onWriteAttempted?.();
    if (this.outcome === 'write-throws-after-partial') {
      throw new Error('synthetic partial write failure');
    }
  }

  async submit(): Promise<void> {
    this.submitCount += 1;
    this.submitted = true;
    if (this.outcome === 'submit-resolves-after-deadline') {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return;
    }
    if (
      this.outcome === 'recovery-submit-throws-after-caller' &&
      this.submitCount === 1
    ) {
      // A pre-caller local-command group whose terminal output never completes a Local Command
      // Turn is what arms the one observation-based recovery submit.
      await appendFile(
        this.logPath,
        `${syntheticPreCallerLocalCommandEvents(this.cwd)
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
      );
      return;
    }
    if (
      this.outcome === 'recovery-submit-throws-after-caller' &&
      this.submitCount === 2
    ) {
      this.draft = null;
      await appendFile(
        this.logPath,
        `${JSON.stringify(syntheticCallerEvent(this.cwd))}\n`,
      );
      throw new Error('synthetic recovery submit failure');
    }
    if (this.outcome === 'submit-throws-after-caller') {
      this.draft = null;
      await appendFile(
        this.logPath,
        `${JSON.stringify(syntheticCallerEvent(this.cwd))}\n`,
      );
      throw new Error('synthetic submit failure');
    }
    if (this.outcome === 'recovery-drop-to-empty' && this.submitCount === 1) {
      await appendFile(
        this.logPath,
        `${syntheticPreCallerLocalCommandEvents(this.cwd)
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
      );
      return;
    }
    this.draft = null;
    if (
      this.outcome === 'drop-before-draft-render' ||
      this.outcome === 'drop-to-empty-input' ||
      this.outcome === 'is-alive-throws-after-submit' ||
      this.outcome === 'recovery-drop-to-empty' ||
      this.outcome === 'caller-during-shutdown' ||
      this.outcome === 'intermittent-pre-caller-selection' ||
      this.outcome === 'malformed-record-during-shutdown' ||
      this.outcome === 'partial-caller-during-shutdown' ||
      this.outcome === 'stall-on-pre-caller-selection'
    ) {
      return;
    }
    const events = this.outcome === 'complete' || this.outcome === 'delayed-draft-render'
      ? syntheticCompletedTurnEvents(this.cwd)
      : [syntheticCallerEvent(this.cwd)];
    await appendFile(
      this.logPath,
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async terminate(): Promise<void> {
    this.terminateCount += 1;
    if (this.alive && this.outcome === 'caller-during-shutdown') {
      await appendFile(
        this.logPath,
        `${JSON.stringify(syntheticCallerEvent(this.cwd))}\n`,
      );
    }
    if (this.alive && this.outcome === 'partial-caller-during-shutdown') {
      await appendFile(this.logPath, '{"type":"user"');
    }
    if (this.alive && this.outcome === 'malformed-record-during-shutdown') {
      await appendFile(this.logPath, '{"type":"user"\n');
    }
    this.alive = false;
  }

  async exit(): Promise<void> {
    if (this.alive) {
      this.exitWhileAliveCount += 1;
    }
    if (this.alive && this.outcome === 'caller-during-shutdown') {
      await appendFile(
        this.logPath,
        `${JSON.stringify(syntheticCallerEvent(this.cwd))}\n`,
      );
    }
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    if (this.outcome === 'is-alive-throws-after-submit' && this.submitted) {
      throw new Error('synthetic post-submit liveness failure');
    }
    if (
      this.outcome === 'intermittent-pre-caller-selection' &&
      this.postSubmitCaptureCount >= 7
    ) {
      return false;
    }
    return this.alive;
  }

  async captureText(): Promise<string> {
    this.captureTextCount += 1;
    if (this.outcome === 'complete') {
      throw new Error(
        'ready resumed input must not scan a synthetic stale transcript containing Quick safety check or trust this folder',
      );
    }
    return [
      'SYNTHETIC BACKEND SELECTION SCREEN',
      SYNTHETIC_MENU_LINE,
      '  2. SYNTHETIC ALTERNATIVE',
    ].join('\n');
  }

  async captureCursorLine(): Promise<string> {
    if (this.draft !== null) {
      this.draftCaptureCount += 1;
      if (this.outcome === 'drop-before-draft-render') {
        return '❯';
      }
      if (this.outcome === 'delayed-draft-render' && this.draftCaptureCount <= 16) {
        return '❯';
      }
      return `❯ ${this.draft}`;
    }
    if (!this.submitted && this.outcome === 'menu-before-write') {
      this.preSubmitCaptureCount += 1;
      return this.preSubmitCaptureCount >= 3 ? SYNTHETIC_MENU_LINE : '❯';
    }
    if (
      this.submitted &&
      (
        this.outcome === 'selection-with-unreadable-recovery-capture' ||
        this.outcome === 'stall-on-pre-caller-selection' ||
        this.outcome === 'stall-on-selection'
      )
    ) {
      if (
        this.outcome === 'selection-with-unreadable-recovery-capture' &&
        ++this.postSubmitCaptureCount === 2
      ) {
        throw new Error('synthetic recovery cursor capture failure');
      }
      return SYNTHETIC_MENU_LINE;
    }
    if (this.submitted && this.outcome === 'intermittent-pre-caller-selection') {
      this.postSubmitCaptureCount += 1;
      if (this.postSubmitCaptureCount % 3 === 1) {
        return SYNTHETIC_MENU_LINE;
      }
      return this.postSubmitCaptureCount % 3 === 2 ? '❯' : 'SYNTHETIC WORKING';
    }
    return '❯';
  }
}

class AbortDuringSurfaceCaptureSession extends SyntheticTurnSession {
  constructor(
    logPath: string,
    cwd: string,
    private readonly controller: AbortController,
  ) {
    super(logPath, cwd, 'complete');
  }

  async captureCursorSurface(): Promise<{
    readonly line: string;
    readonly cursorRow: number;
    readonly cursorColumn: number;
  }> {
    this.controller.abort();
    await Promise.resolve();
    return { line: '❯', cursorRow: 20, cursorColumn: 2 };
  }
}

class DelayedSurfaceCaptureSession extends SyntheticTurnSession {
  constructor(
    logPath: string,
    cwd: string,
    private readonly delayMs: number,
  ) {
    super(logPath, cwd, 'complete');
  }

  async captureCursorSurface(): Promise<{
    readonly line: string;
    readonly cursorRow: number;
    readonly cursorColumn: number;
  }> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { line: '❯', cursorRow: 20, cursorColumn: 2 };
  }
}

class StatusRowAfterWriteSession extends SyntheticTurnSession {
  constructor(logPath: string, cwd: string) {
    super(logPath, cwd, 'complete');
  }

  async captureCursorSurface(): Promise<{
    readonly line: string;
    readonly cursorRow: number;
    readonly cursorColumn: number;
  }> {
    return this.writes.length === 0
      ? { line: '❯', cursorRow: 20, cursorColumn: 2 }
      : { line: 'SYNTHETIC WORKING', cursorRow: 20, cursorColumn: 17 };
  }

  async moveCursorToStart(): Promise<void> {}
  async moveCursorToEnd(): Promise<void> {}
}

class EditableDraftAfterWriteSession extends SyntheticTurnSession {
  moveStartCount = 0;
  moveEndCount = 0;
  private cursorColumn = 2;
  private visibleDraft: string | null = null;
  private postWriteEndCount = 0;

  constructor(logPath: string, cwd: string) {
    super(logPath, cwd, 'complete');
  }

  async write(input: string): Promise<void> {
    await super.write(input);
    this.visibleDraft = input.slice(0, -7);
    this.cursorColumn = 2 + this.visibleDraft.length;
  }

  async captureCursorSurface(): Promise<{
    readonly line: string;
    readonly cursorRow: number;
    readonly cursorColumn: number;
  }> {
    if (this.submitted) {
      return { line: '❯', cursorRow: 20, cursorColumn: 2 };
    }
    if (this.writes.length === 0) {
      return {
        line: '❯ Try "synthetic suggestion"',
        cursorRow: 20,
        cursorColumn: 2,
      };
    }
    return {
      line: `❯ ${this.visibleDraft}`,
      cursorRow: 20,
      cursorColumn: this.cursorColumn,
    };
  }

  async moveCursorToStart(): Promise<void> {
    this.moveStartCount += 1;
    if (!this.submitted && this.writes.length > 0) {
      setTimeout(() => {
        this.cursorColumn = 2;
      }, 50);
    }
  }

  async moveCursorToEnd(): Promise<void> {
    this.moveEndCount += 1;
    if (!this.submitted && this.writes.length > 0) {
      this.postWriteEndCount += 1;
      const fullDraft = this.writes.at(-1) ?? '';
      setTimeout(() => {
        if (this.postWriteEndCount === 1) {
          this.visibleDraft = fullDraft;
        }
        this.cursorColumn = 2 + (this.visibleDraft?.length ?? 0);
      }, 50);
    }
  }
}

class TransientReadySession implements PtySession {
  readonly id = 'synthetic-transient-ready-session';
  captureCursorLineCount = 0;

  async write(): Promise<void> {}
  async submit(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async terminate(): Promise<void> {}
  async exit(): Promise<void> {}

  async isAlive(): Promise<boolean> {
    return true;
  }

  async captureText(): Promise<string> {
    return 'SYNTHETIC STARTUP';
  }

  async captureCursorLine(): Promise<string> {
    this.captureCursorLineCount += 1;
    return this.captureCursorLineCount === 2 ? 'SYNTHETIC STARTUP' : '❯';
  }
}

class SyntheticProvider implements PtyProvider {
  constructor(private readonly session: PtySession) {}

  async start(): Promise<PtySession> {
    return this.session;
  }
}

interface SyntheticEnvironment {
  readonly cwd: string;
  readonly configDir: string;
  readonly fakeClaudeBin: string;
  readonly logPath: string;
}

async function withSyntheticClaudeEnvironment(
  label: string,
  run: (environment: SyntheticEnvironment) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `openp-synthetic-${label}-`));
  const cwd = join(root, 'workspace');
  const configDir = join(root, 'claude-config');
  const binDir = join(root, 'bin');
  const stateRoot = join(root, 'state');
  const fakeClaudeBin = join(binDir, 'claude');
  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;

  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    fakeClaudeBin,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "%s\\n" "synthetic-claude 0.0.0"; exit 0; fi\nexit 1\n',
  );
  await chmod(fakeClaudeBin, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = stateRoot;

  const logDir = resolveClaudeCodeProjectLogDir(cwd, configDir);
  const logPath = join(logDir, `${SYNTHETIC_SESSION_ID}.jsonl`);
  await mkdir(logDir, { recursive: true });
  await writeFile(logPath, '');
  await new SessionStateStore(cwd).save({
    backend: 'claude',
    backendSessionId: SYNTHETIC_SESSION_ID,
    cwd,
    lastProviderSessionId: SYNTHETIC_SESSION_ID,
    sessionLogPath: logPath,
    lastTurnId: null,
  });

  try {
    await run({ cwd, configDir, fakeClaudeBin, logPath });
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('XDG_STATE_HOME', previousStateRoot);
  }
}

function adapterResumeOptions(cwd: string) {
  return {
    cwd,
    backendSessionId: SYNTHETIC_SESSION_ID,
    resume: true,
    timeoutMs: 0,
    model: null,
    reasoningEffort: null,
    permissionMode: null,
    nativePermissionMode: null,
    jsonSchema: null,
    backendArgs: [],
    debugLog: null,
    settlePendingSeedAppend: async () => undefined,
  };
}

async function startSyntheticPersistentProcess(
  environment: SyntheticEnvironment,
  session: PtySession,
): Promise<PersistentClaudeCodeProcess> {
  return startPersistentClaudeCodeProcess({
    sessionId: SYNTHETIC_SESSION_ID,
    launchSignature: buildLaunchSignature({
      backendId: 'claude',
      bin: environment.fakeClaudeBin,
      binArgs: [],
      env: { CLAUDE_CONFIG_DIR: environment.configDir },
      local: false,
    }),
    resume: true,
    cwd: environment.cwd,
    provider: new SyntheticProvider(session),
    timeoutMs: 0,
  });
}

async function withAcceleratedSelectionStallClock(
  session: SyntheticTurnSession,
  run: () => Promise<void>,
): Promise<void> {
  const originalDateNow = Date.now;
  let nowMs: number | null = null;
  Date.now = () => {
    if (!session.submitted) {
      return originalDateNow();
    }
    nowMs ??= originalDateNow();
    const observed = nowMs;
    nowMs += 300_001;
    return observed;
  };
  try {
    await run();
  } finally {
    Date.now = originalDateNow;
  }
}

function isSelectionPromptFailure(error: unknown): boolean {
  return error instanceof OpenPError &&
    error.exitCode === EXIT_CODES.backendStartFailed &&
    /interactive selection prompt/.test(error.message) &&
    error.message.includes('SYNTHETIC HUMAN CHOICE');
}

function isPromptNotExecutedFailure(error: unknown): boolean {
  return error instanceof OpenPError &&
    error.exitCode === EXIT_CODES.protocolViolation &&
    error.reasonCode === ARTIFACT_REJECTION_REASONS.promptNotExecuted;
}

function isMissingTurnBoundaryFailure(error: unknown): boolean {
  return error instanceof OpenPError &&
    error.exitCode === EXIT_CODES.protocolViolation &&
    error.reasonCode === ARTIFACT_REJECTION_REASONS.missingTurnBoundary;
}

function syntheticCompletedTurnEvents(cwd: string): object[] {
  return [
    syntheticCallerEvent(cwd),
    {
      type: 'assistant',
      uuid: 'synthetic-assistant-event',
      parentUuid: 'synthetic-caller-event',
      sessionId: SYNTHETIC_SESSION_ID,
      cwd,
      requestId: 'synthetic-request',
      message: {
        id: 'synthetic-assistant-message',
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model',
        content: [{ type: 'text', text: SYNTHETIC_RESULT }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    },
    {
      type: 'system',
      subtype: 'turn_duration',
      sessionId: SYNTHETIC_SESSION_ID,
      cwd,
      durationMs: 1,
    },
  ];
}

function syntheticPreCallerLocalCommandEvents(cwd: string): object[] {
  return [
    {
      type: 'user',
      uuid: 'synthetic-local-command-caveat',
      sessionId: SYNTHETIC_SESSION_ID,
      cwd,
      promptId: 'synthetic-local-command',
      isMeta: true,
      message: {
        role: 'user',
        content: '<local-command-caveat>Caveat</local-command-caveat>',
      },
    },
    {
      type: 'user',
      uuid: 'synthetic-local-command-stdout',
      sessionId: SYNTHETIC_SESSION_ID,
      cwd,
      promptId: 'synthetic-local-command',
      message: {
        role: 'user',
        content: '<local-command-stdout>synthetic command output</local-command-stdout>',
      },
    },
  ];
}

function syntheticCallerEvent(cwd: string): object {
  return {
    type: 'user',
    uuid: 'synthetic-caller-event',
    sessionId: SYNTHETIC_SESSION_ID,
    cwd,
    message: {
      role: 'user',
      content: [{ type: 'text', text: SYNTHETIC_PROMPT }],
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
