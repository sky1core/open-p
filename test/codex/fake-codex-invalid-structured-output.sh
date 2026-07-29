#!/bin/bash
echo '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"not json"}]}}'
echo '{"type":"turn.completed","session_id":"22222222-2222-4222-8222-222222222222","result":"not json","usage":{"input_tokens":20,"output_tokens":4,"cached_input_tokens":5}}'
exit 0
