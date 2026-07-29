#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

// Records that the OpenCode child actually started. The unreachable-endpoint test asserts this
// marker is absent, which is what pins the connectivity check to its pre-spawn position.
writeFileSync('opencode-child-started.marker', 'started\n');

process.stdout.write(JSON.stringify({
  type: 'result',
  sessionID: 'ses_fake_success',
  result: 'fake success',
  usage: { input_tokens: 1, output_tokens: 2 },
}) + '\n');
