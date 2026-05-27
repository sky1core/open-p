#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const RESPONSE = 'Intro\n\nA\n\nAB\n\nABC';

const lastMessagePath = valueAfter('--output-last-message');
if (lastMessagePath) {
  writeFileSync(lastMessagePath, `${RESPONSE}\n`, 'utf8');
}

writeJson({ type: 'thread.started', thread_id: SESSION_ID });
writeJson({ type: 'turn.started' });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Intro' }] } });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'A' }] } });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'AB' }] } });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ABC' }] } });
writeJson({
  type: 'turn.completed',
  result: RESPONSE,
  usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 },
});

function valueAfter(flag) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
