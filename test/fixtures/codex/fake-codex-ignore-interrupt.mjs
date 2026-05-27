#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const signalLog = process.env.OPENP_FAKE_CODEX_SIGNAL_LOG;

process.on('SIGINT', () => {
  logSignal('SIGINT');
});

process.on('SIGTERM', () => {
  logSignal('SIGTERM');
});

console.log('{"type":"fixture.ready"}');

setInterval(() => undefined, 1000);

function logSignal(signal) {
  if (signalLog) {
    appendFileSync(signalLog, `${signal}\n`);
  }
}
