#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.env.OPENP_FAKE_CODEX_ARGS_LOG) {
  appendFileSync(process.env.OPENP_FAKE_CODEX_ARGS_LOG, `ARGS\t${process.argv.slice(2).join('\t')}\n`);
}

process.stdout.write(`${JSON.stringify({
  type: 'thread.started',
  thread_id: '22222222-2222-4222-8222-222222222222',
})}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
const providerError = JSON.stringify({
  type: 'error',
  status: 400,
  error: {
    type: 'invalid_request_error',
    message: "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', and 'xhigh'.",
  },
});
process.stdout.write(`${JSON.stringify({ type: 'error', message: providerError })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: providerError } })}\n`);
process.exit(1);
