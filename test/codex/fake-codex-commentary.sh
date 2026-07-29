#!/bin/bash
# Fake codex that emits commentary progress before the final response.
echo '{"type":"thread.started","thread_id":"22222222-2222-4222-8222-222222222222"}'
echo '{"type":"event_msg","payload":{"type":"agent_message","message":"checking files...","phase":"commentary"}}'
echo '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"checking files..."}],"phase":"commentary"}}'
echo '{"type":"turn.completed","session_id":"22222222-2222-4222-8222-222222222222","result":"final answer here","usage":{"input_tokens":10,"output_tokens":2}}'
exit 0
