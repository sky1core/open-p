#!/bin/bash
# Fake codex that returns result but no session id
if [[ " $* " == *" resume "* ]]; then
  SESSION_ID="${@: -2:1}"
  CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  SESSION_DIR="$CODEX_HOME_DIR/sessions/2026/05/23"
  LOG_PATH="$SESSION_DIR/rollout-$SESSION_ID.jsonl"
  mkdir -p "$SESSION_DIR"
  echo '{"type":"event_msg","payload":{"type":"user_message","message":"resume prompt"}}' >> "$LOG_PATH"
  echo '{"type":"turn.completed","result":"answer without session","usage":{"input_tokens":50,"output_tokens":10}}' >> "$LOG_PATH"
fi
echo '{"type":"turn.completed","result":"answer without session","usage":{"input_tokens":50,"output_tokens":10}}'
exit 0
