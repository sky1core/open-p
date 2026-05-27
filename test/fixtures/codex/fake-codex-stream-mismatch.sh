#!/bin/bash
# Fake codex that streams assistant text different from the final result.
echo '{"type":"thread.started","thread_id":"22222222-2222-4222-8222-222222222222"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"streamed draft"}}'
echo '{"type":"turn.completed","session_id":"22222222-2222-4222-8222-222222222222","result":"final answer here","usage":{"input_tokens":10,"output_tokens":2}}'
exit 0
