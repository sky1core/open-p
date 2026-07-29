#!/bin/bash
# Fake codex that returns a different session id than the requested resume id.
echo '{"type":"turn.completed","session_id":"33333333-3333-4333-8333-333333333333","result":"wrong session","usage":{"input_tokens":50,"output_tokens":10}}'
exit 0
