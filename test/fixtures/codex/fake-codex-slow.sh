#!/bin/bash
# Fake codex that takes too long (for timeout tests)
sleep 60 &
child=$!
log_signal() {
  if [ -n "$OPENP_FAKE_CODEX_SIGNAL_LOG" ]; then
    printf '%s\n' "$1" >> "$OPENP_FAKE_CODEX_SIGNAL_LOG"
  fi
}
trap 'log_signal SIGTERM; kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 143' TERM
trap 'log_signal SIGINT; kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 130' INT
wait "$child"
echo '{"type":"turn.completed","session_id":"slow","result":"too late","usage":{}}'
exit 0
