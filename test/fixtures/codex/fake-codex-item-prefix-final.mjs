#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const STREAMED_FINAL_PREFIX = 'final';
const FINAL = 'final answer';

const lastMessagePath = valueAfter('--output-last-message');
if (lastMessagePath) {
  writeFileSync(lastMessagePath, `${FINAL}\n`, 'utf8');
}

writeJson({ type: 'thread.started', thread_id: SESSION_ID });
writeJson({ type: 'turn.started' });
writeJson({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: STREAMED_FINAL_PREFIX } });
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
