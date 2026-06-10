#!/bin/bash
# Fake codex that completes a turn but produces no answer text or artifacts.
echo '{"type":"turn.completed","session_id":"22222222-2222-4222-8222-222222222222","usage":{"input_tokens":10,"output_tokens":0,"cached_input_tokens":0}}'
exit 0
