#!/usr/bin/env node

const sessionId = '22222222-2222-4222-8222-222222222222';

const events = [
  { type: 'thread.started', thread_id: sessionId },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'checking files...' }],
    },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'progress',
      message: 'running tests...',
    },
  },
  {
    type: 'turn.completed',
    session_id: sessionId,
    usage: { input_tokens: 10, output_tokens: 2 },
  },
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
