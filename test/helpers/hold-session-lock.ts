import { SessionLockStore } from '../../src/core/session-lock.js';

const [projectRoot, sessionId, holdMsText] = process.argv.slice(2);
if (!projectRoot || !sessionId || !holdMsText) {
  process.stderr.write('usage: hold-session-lock <project-root> <session-id> <hold-ms>\n');
  process.exitCode = 2;
} else {
  const holdMs = Number(holdMsText);
  if (!Number.isFinite(holdMs) || holdMs <= 0) {
    process.stderr.write(`invalid hold-ms: ${holdMsText}\n`);
    process.exitCode = 2;
  } else {
    const lock = await new SessionLockStore(projectRoot).acquire(sessionId);
    try {
      process.stdout.write(`${lock.path}\n`);
      // holdMs is an upper bound; a SIGTERM/SIGINT from the test releases the lock immediately so
      // the hold window never races the competing process's startup time.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, holdMs);
        const onSignal = (): void => {
          clearTimeout(timer);
          resolve();
        };
        process.once('SIGTERM', onSignal);
        process.once('SIGINT', onSignal);
      });
    } finally {
      await lock.release();
    }
  }
}
