#!/usr/bin/env node

process.stdout.write(`${JSON.stringify({
  type: 'thread.started',
  thread_id: '22222222-2222-4222-8222-222222222222',
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_0',
    type: 'error',
    message: 'Model metadata for `gpt-5.6` not found. Defaulting to fallback metadata.',
  },
})}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
const providerError = JSON.stringify({
  type: 'error',
  status: 400,
  error: {
    type: 'invalid_request_error',
    message: "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
  },
});
process.stdout.write(`${JSON.stringify({ type: 'error', message: providerError })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: providerError } })}\n`);
process.exit(1);
