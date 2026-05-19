# open-p

open-p is a PTY-based compatibility layer for running prompt-driven turns through interactive agent CLIs.

The initial backend runs Claude Code without backend print mode. Text-prompt turns use the PTY/session-log runner. Stream-json worker turns use Claude Code's non-print stream-json stdin/stdout mode and format that structured output into the public compatibility contract.

## Current Support

The current implementation supports trusted local workspaces:

- start a Claude Code interactive session in tmux
- submit one prompt after the TTY is ready
- read the local Claude Code session log
- extract one final response
- write the response to stdout
- persist local session state outside the target project tree
- serialize same-session turns with a local lock
- resume a known local session with `--resume`
- read one or more `stream-json` user events from stdin with `--input-format stream-json --output-format stream-json`
- write a structured JSON result with `--output-format json`
- write JSONL result events with `--output-format stream-json`
- validate `--json-schema` structured output and emit `structured_output` in JSON result events
- emit a minimal `system init` event in stream-json mode before assistant/result events
- emit default stream-json assistant updates as scoped cumulative snapshots that callers should treat as whole-message replacements
- expose `--include-partial-messages` for callers that want Claude-style partial `stream_event` deltas when snapshots are prefix-compatible
- return non-zero exit codes for usage, backend, timeout, and protocol failures

The final result is derived from Claude Code structured output. In text-prompt mode that source is the scoped local session log; in stream-json WorkerBridge mode it is the internal Claude Code stream-json stdout result. Default `stream-json` assistant events are emitted from scoped structured assistant snapshots, not from terminal screen text. Those default assistant events may be cumulative snapshots rather than fine-grained deltas; consumers should replace the displayed assistant text with the latest snapshot for the active turn. `--include-partial-messages` is the explicit opt-in path for Claude-style partial `stream_event` lifecycle and delta events. open-p does not read private transport credentials. Command-name compatibility is available only through the optional shim workflow; it is not installed as the default package executable.
The `stream-json` output mode follows the supported `claude` stream-json public event shape with the documented cumulative-snapshot exception above and must not publish `open-p`-specific stdout fields.

## Name

- Project: `open-p`
- Default binary: `openp`
- Optional compatibility shim: `claude`

The optional shim is not the default executable. It is only for environments that explicitly need command-name compatibility.

## Install From Source

```bash
npm install
npm link
openp --version
```

The package executable points at `dist/src/cli.js`. `npm install` runs the build through the package `prepare` script. If lifecycle scripts are disabled, run `npm run build` before linking or running the binary from a fresh checkout.

## Optional Command Shim

Some automation tools resolve the command name `claude`. To use open-p for that path, install an explicit shim directory and put that directory first on the tool's agent `PATH`:

```bash
npm run build
npm run install:claude-shim -- --target-dir ~/.local/share/open-p/shims --claude-bin "$(command -v claude)"
```

The shim sets `OPENP_CLAUDE_CODE_BIN` to the real Claude Code binary before invoking open-p. This prevents recursive shim invocation when open-p starts the interactive backend.

## Principles

- No MITM.
- No TLS interception.
- No credential capture.
- No private transport parsing.
- No terminal screen scraping as the source of truth.
- No PTY screen text in the public stdout streaming contract.

The runner observes structured artifacts or structured stdout produced by the backend CLI and treats terminal rendering as an execution surface, not as a response API.

## CLI Shape

```bash
openp claude "prompt"
echo "prompt" | openp claude
openp claude --session-id <uuid> "prompt"
openp claude --resume <uuid> "prompt"
openp claude --timeout 60 "prompt"
openp claude --output-format json "prompt"
openp claude --output-format json --json-schema '{"type":"object"}' "prompt"
openp claude --output-format stream-json "prompt"
openp claude --output-format stream-json --include-partial-messages "prompt"
printf '{"type":"user","message":{"content":"prompt"}}\n' | openp claude --input-format stream-json --output-format stream-json
printf '{"type":"user","message":{"content":"prompt"}}\n' | openp claude --input-format stream-json --output-format stream-json --include-partial-messages
printf '%s\n%s\n' \
  '{"type":"user","message":{"content":"first prompt"}}' \
  '{"type":"user","message":{"content":"second prompt"}}' \
  | openp claude --input-format stream-json --output-format stream-json
```

The first argument (`claude`) is the backend subcommand. It selects the `claude-code` backend. A backend is always required; there is no implicit default.

## Workspace Trust

Claude Code print mode skips the workspace trust dialog in non-interactive output. For compatibility, `openp` confirms the initial Claude Code workspace trust prompt once when starting the interactive backend. If the backend still waits for startup input after that confirmation, `openp` fails closed instead of parsing the terminal screen.
