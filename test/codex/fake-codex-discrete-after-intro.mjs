#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const FINAL = 'Intro\n\nA\n\nB\n\nC';

const lastMessagePath = valueAfter('--output-last-message');
if (lastMessagePath) {
  writeFileSync(lastMessagePath, `${FINAL}\n`, 'utf8');
}

writeJson({ type: 'thread.started', thread_id: SESSION_ID });
writeJson({ type: 'turn.started' });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Intro' }] } });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'A' }] } });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'B' }] } });
writeJson({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'C' }] } });
writeJson({
  type: 'turn.completed',
  result: FINAL,
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
