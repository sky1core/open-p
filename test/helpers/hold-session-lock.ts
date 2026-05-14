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
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    } finally {
      await lock.release();
    }
  }
}
