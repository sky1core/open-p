#!/usr/bin/env node

const sessionId = '22222222-2222-4222-8222-222222222222';

const events = [
  { type: 'thread.started', thread_id: sessionId },
  {
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: 'call_stdout',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_stdout',
      output: 'file contents',
    },
  },
  {
    type: 'turn.completed',
    session_id: sessionId,
    result: 'final with tool',
    usage: { input_tokens: 10, output_tokens: 2 },
  },
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
