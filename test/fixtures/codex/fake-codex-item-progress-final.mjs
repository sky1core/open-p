#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROGRESS_ONE = 'checking sources';
const PROGRESS_TWO = 'sources checked';
const ANSWER = 'final researched answer';

const lastMessagePath = valueAfter('--output-last-message');
if (lastMessagePath) {
  writeFileSync(lastMessagePath, `${ANSWER}\n`, 'utf8');
}

writeJson({ type: 'thread.started', thread_id: SESSION_ID });
writeJson({ type: 'turn.started' });
writeJson({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: PROGRESS_ONE } });
writeJson({ type: 'item.started', item: { id: 'item_1', type: 'web_search' } });
writeJson({ type: 'item.completed', item: { id: 'item_1', type: 'web_search' } });
writeJson({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: PROGRESS_TWO } });
writeJson({ type: 'item.started', item: { id: 'item_3', type: 'web_search' } });
writeJson({ type: 'item.completed', item: { id: 'item_3', type: 'web_search' } });
writeJson({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: ANSWER } });
writeJson({
  type: 'turn.completed',
  result: ANSWER,
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
