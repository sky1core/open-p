#!/bin/bash
# Fake codex that emits commentary text equal to the final response.
echo '{"type":"thread.started","thread_id":"33333333-3333-4333-8333-333333333333"}'
echo '{"type":"event_msg","payload":{"type":"agent_message","message":"same answer","phase":"commentary"}}'
echo '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"same answer"}],"phase":"commentary"}}'
echo '{"type":"turn.completed","session_id":"33333333-3333-4333-8333-333333333333","result":"same answer","usage":{"input_tokens":10,"output_tokens":2}}'
exit 0
