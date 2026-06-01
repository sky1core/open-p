#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const sessionId = args.at(-2) ?? '22222222-2222-4222-8222-222222222222';
const outputLastMessageIndex = args.indexOf('--output-last-message');
const outputLastMessagePath = outputLastMessageIndex >= 0
  ? args[outputLastMessageIndex + 1]
  : null;

function emitStdout(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (outputLastMessagePath) {
  await writeFile(outputLastMessagePath, 'stdout-only final answer', 'utf8');
}

emitStdout({
  type: 'response_item',
  payload: {
    type: 'reasoning',
    summary: [{ text: 'stdout-only reasoning' }],
  },
});

emitStdout({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'stdout-only commentary' }],
  },
});

emitStdout({
  type: 'turn.completed',
  session_id: sessionId,
  result: 'stdout-only final answer',
  usage: {
    input_tokens: 120,
    cached_input_tokens: 30,
    output_tokens: 12,
  },
});
