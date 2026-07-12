#!/usr/bin/env node

const [, , backend, ...args] = process.argv;

if (backend === 'claude') {
  assertArgs(args, ['auth', 'status', '--json']);
  if (process.env.OPENP_FAKE_CLAUDE_LOGIN === 'malformed') {
    process.stdout.write('{bad json');
    process.exit(0);
  }
  const loggedIn = process.env.CLAUDE_CONFIG_DIR !== process.env.OPENP_FAKE_LOGGED_OUT_CLAUDE_DIR;
  process.stdout.write(JSON.stringify(loggedIn
    ? { loggedIn: true, authMethod: 'fake', email: 'must-not-leak@example.test', orgName: 'must-not-leak' }
    : { loggedIn: false, authMethod: 'none' }));
  process.exit(loggedIn ? 0 : 1);
}

if (backend === 'codex') {
  assertArgs(args, ['login', 'status']);
  const loggedIn = process.env.CODEX_HOME !== process.env.OPENP_FAKE_LOGGED_OUT_CODEX_HOME;
  process.stderr.write(loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exit(loggedIn ? 0 : 1);
}

if (backend === 'kiro') {
  assertArgs(args, ['whoami', '-f', 'json']);
  if (process.env.OPENP_FAKE_KIRO_LOGIN === 'malformed') {
    process.stdout.write(JSON.stringify({ account: null, accountType: 'contradictory' }));
    process.exit(0);
  }
  const loggedIn = process.env.OPENP_FAKE_KIRO_LOGIN !== 'false';
  process.stdout.write(JSON.stringify(loggedIn
    ? { accountType: 'fake', email: 'must-not-leak@example.test', region: 'must-not-leak', startUrl: 'must-not-leak' }
    : { account: null }));
  process.exit(loggedIn ? 0 : 1);
}

process.stderr.write(`unsupported fake auth backend: ${String(backend)}\n`);
process.exit(2);

function assertArgs(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    process.stderr.write(`unexpected args: ${JSON.stringify(actual)}\n`);
    process.exit(2);
  }
}
