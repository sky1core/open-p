#!/bin/bash
# Fake codex that outputs a successful turn.completed event on stdout
if [ -n "$OPENP_FAKE_CODEX_ARGS_LOG" ]; then
  printf 'ARGS' >> "$OPENP_FAKE_CODEX_ARGS_LOG"
  for arg in "$@"; do
    printf '\t%s' "$arg" >> "$OPENP_FAKE_CODEX_ARGS_LOG"
  done
  printf '\n' >> "$OPENP_FAKE_CODEX_ARGS_LOG"
fi
SESSION_ID='22222222-2222-4222-8222-222222222222'
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
SESSION_DIR="$CODEX_HOME_DIR/sessions/2026/05/23"
LOG_PATH="$SESSION_DIR/rollout-$SESSION_ID.jsonl"
mkdir -p "$SESSION_DIR"
{
  echo '{"type":"turn_context","payload":{"model":"codex-test-model"}}'
  echo '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}'
  echo '{"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"Thinking about it..."}],"content":null}}'
  echo '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":100,"output_tokens":40},"last_token_usage":{"input_tokens":200,"cached_input_tokens":100,"output_tokens":40},"model_context_window":200000}}}'
  echo '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"final answer here"}]}}'
  echo '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1700,"cached_input_tokens":900,"output_tokens":340},"last_token_usage":{"input_tokens":1500,"cached_input_tokens":800,"output_tokens":300},"model_context_window":200000}}}'
  echo '{"type":"event_msg","payload":{"type":"task_complete"}}'
} >> "$LOG_PATH"
echo '{"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"Thinking about it..."}],"content":null}}'
echo '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"final answer here"}]}}'
echo '{"type":"turn.completed","session_id":"22222222-2222-4222-8222-222222222222","result":"final answer here","usage":{"input_tokens":200,"output_tokens":40,"cached_input_tokens":100}}'
exit 0
