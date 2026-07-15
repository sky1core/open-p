# open-p

A local agent CLI compatibility layer for running prompt-driven turns through supported backend CLIs.

`openp` wraps one prompt turn through a selected backend and returns the result through a stable `openp` JSON interface.

## Prerequisites

- **Node.js** >= 20
- **tmux** (used internally by the Claude backend PTY runner; `brew install tmux` on macOS, `apt install tmux` on Debian/Ubuntu)
- At least one backend CLI installed:

| Backend | Required CLI | Install |
|---|---|---|
| Claude | `claude` | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) |
| Codex | `codex` | [Codex CLI](https://github.com/openai/codex) |
| Kiro | `kiro-cli` | [Kiro CLI](https://kiro.dev) |
| OpenCode | `opencode` plus a local provider; MLX-LM is the recommended local path on Apple Silicon | [OpenCode](https://opencode.ai) |

## Install

```bash
git clone https://github.com/sky1core/open-p.git
cd open-p
npm install
npm run build
npm link
openp --version
```

## Quick Start

```bash
openp claude "hello"
openp codex "hello"
openp kiro "hello"
openp opencode --model mlx-lm/default_model "hello"
```

The first positional argument selects the backend. There is no default backend.

Pipe from stdin:

```bash
echo "summarize this" | openp claude
```

## Backend Login Status

Check whether the installed Claude, Codex, and Kiro CLIs recognize a logged-in account:

```bash
openp auth-status
```

The command returns one boolean per built-in backend and configured Claude/Codex instance:

```json
{"openp":{"version":1,"backends":[{"id":"claude","backend":"claude","loggedIn":true}]}}
```

The output intentionally excludes account identity fields. A probe failure fails the command instead of reporting `loggedIn: false`. Login status does not guarantee available quota or a successful model turn.

## Output Formats

| Flag | stdout |
|---|---|
| `--output-format text` | Answer text only |
| `--output-format json` | Single JSON result object |
| `--output-format stream-json` | JSONL records ending with `openp.form: "result"` |

Default is `text`.

### JSON Output

JSON-family outputs use `openp` as the top-level public object. Use `openp.form`, `openp.scope`, and `openp.output` to read the result.

```bash
openp claude --output-format json "hello"
```

```json
{
  "openp": {
    "form": "result",
    "output": {
      "answer": ["hello"],
      "reasoning": [],
      "toolCall": [],
      "toolResult": []
    },
    "sessionId": "...",
    "metadata": { "..." }
  }
}
```

Result `openp.output` contains aggregate arrays for `answer`, `reasoning`, `toolCall`, and `toolResult`.

### Streaming

By default, `stream-json` output emits only the terminal result record. Use `--streaming` to receive active-turn streaming events as the backend works:

```bash
openp claude --output-format stream-json --streaming "hello"
```

Streaming records use `openp.form: "streaming"` with a strict oneOf `openp.output`:

```json
{"openp": {"form": "streaming", "output": {"answer": "hel"}}}
{"openp": {"form": "streaming", "output": {"answer": "hello"}}}
{"openp": {"form": "result", "output": {"answer": ["hello"], "reasoning": [], "toolCall": [], "toolResult": []}}}
```

Streaming `answer` and `reasoning` values are cumulative snapshots, not deltas. Tool streaming records contain complete objects.

## Model And Effort Selection

`openp` does not maintain model or reasoning-effort availability catalogs. For a backend that exposes native selectors, caller-provided non-empty `--model` and `--effort` values are passed unchanged through the backend-specific native option mapping. The backend CLI remains the authority on whether a value is accepted; a rejection is returned as a backend-exit error with available native diagnostics instead of an open-p enum-validation error.

OpenCode is the bounded exception for provider selection: its local-private backend still requires one of its configured localhost provider prefixes. This is a network/privacy boundary, not validation that a particular model id exists. The model id after the prefix and the effort value are passed unchanged.

## Codex Backend Notes

The Codex backend does not publish a hardcoded model or reasoning-effort catalog. `--model <model>` is passed through to Codex CLI as `--model <model>`, and `--effort <level>` is passed through as `-c model_reasoning_effort="<level>"`.

If Codex rejects the requested model or effort, `openp` preserves the Codex diagnostic in the non-zero exit error instead of replacing it with a generic failure. For example, unsupported models and invalid reasoning-effort enum values are reported from Codex's own JSON output when available.

When a Codex session log exposes the actual selected model, result metadata reports that model before falling back to the requested model string.

## Kiro Backend Notes

The Kiro backend does not publish a hardcoded model or reasoning-effort catalog. `--model <model>` is passed through to Kiro CLI as `--model <model>`, and `--effort <level>` is passed through as `--effort <level>`.

If Kiro rejects the requested model or effort, `openp` preserves the Kiro stderr diagnostic in the non-zero exit error instead of replacing it with a local enum-validation error.

## Claude Backend Notes

The Claude backend runs through a PTY-backed interactive Claude Code session and reads Claude's local session log for structured turn data. It does not use Claude print mode.

To keep one `openp` invocation mapped to one synchronous prompt turn, the Claude backend disables background/monitor workflows and blocking interactive question tools at launch.

### Backend Instances

Claude and Codex support configured instances: derived backend ids that run with a separate account/config home. Each instance keeps its own login, settings, and session logs, so you can keep independent local CLI profiles side by side.

Define instances in `${XDG_CONFIG_HOME:-~/.config}/open-p/instances.yaml`:

```yaml
instances:
  claude-alt:
    backend: claude
    configDir: ~/.claude-alt
  codex-alt:
    backend: codex
    homeDir: ~/.codex-alt
```

Then select the instance like any backend:

```bash
openp claude-alt "prompt"
openp codex-alt "prompt"
```

Initialize a Codex home before selecting it through open-p:

```bash
CODEX_HOME="$HOME/.codex-alt" codex login
CODEX_HOME="$HOME/.codex-alt" codex login status
```

Notes:

- Claude instances require `configDir`; Codex instances require `homeDir`. The fields are backend-specific and cannot be mixed.
- `configDir` and `homeDir` must be absolute or `~/`-prefixed. Run the backend CLI once with that account/config home to log the profile in before using it through `openp`.
- Instance ids must not collide with built-in backend ids.
- Sessions are bound to the instance that created them; resuming a session through a different backend or instance id fails.
- The base `claude` backend always uses the default Claude Code configuration directory; it does not read an ambient `CLAUDE_CONFIG_DIR`.
- The base `codex` backend keeps Codex's existing `CODEX_HOME` behavior. A Codex instance always uses its configured `homeDir`, even if ambient env or a worker request supplies another `CODEX_HOME`.
- Multiple Codex homes may use the same ChatGPT account, but they share that account's quota and limits; separate homes isolate local auth/config/session files, not billing.
- A Claude instance reads user-scope skills, subagents, and `settings.json` (hooks, permissions) only from its own `configDir`; they are not inherited from the default `~/.claude` profile. Replicate them in the instance directory (copy, or symlink the `skills`/`agents` directories) if you want the same behavior.
- Give each Claude instance `configDir` its own `CLAUDE.md`. Without one, a workspace under `$HOME` makes Claude Code pick up the default `~/.claude/CLAUDE.md` as a project file, and any external `@` import it declares raises a per-workspace "Allow external CLAUDE.md file imports?" approval prompt that an unattended run cannot answer. A `CLAUDE.md` in the instance `configDir` loads the same imports as user scope and skips that prompt.

## OpenCode Backend Notes

The OpenCode backend is intended for local-provider use. On Apple Silicon, prefer `mlx-lm` because it keeps the runtime surface closest to the MLX model server. It requires `--model` with one of the configured local provider ids:

- `mlx-lm/<model-id>` -> `http://localhost:8091/v1`
- `lmstudio/<model-id>` -> `http://localhost:1234/v1`
- `ollama/<model-id>` -> `http://localhost:11434/v1`
- `llama.cpp/<model-id>` -> `http://localhost:8080/v1`

The backend does not publish a hardcoded model or reasoning-effort catalog. Within its required local-provider boundary, `--model <provider>/<model-id>` is passed as OpenCode `--model` and `--effort <level>` is passed unchanged as `--variant <level>`. Non-zero exits preserve bounded OpenCode stdout and stderr diagnostics, including non-JSON output.

OpenCode provider ids are config keys, so the provider id alone is not a privacy boundary. `openp` supplies a private OpenCode config for the selected local provider and does not load ambient OpenCode account data.

Use `lmstudio`, `ollama`, or `llama.cpp` when you want their model management or runtime compatibility layer. They are local-provider options, not the primary MLX-LM path.

On macOS, OpenCode runs under `sandbox-exec` with outbound network access limited to localhost. Ambient cloud/API account variables are not passed to the child process. If the network guard is unavailable, the backend fails closed.

## Sessions

First-turn session ids are generated by `openp` or the backend. To resume a session, capture the session id from JSON output and pass it with `--resume`:

```bash
openp codex --output-format json "first prompt"
# read openp.sessionId from the output
openp codex --resume <session-id> "follow-up"
```

Text output does not include session ids.

## Session Seeding

`openp seed` translates completed user/assistant turns from one native backend session into another
backend's native session format. Each source backend Reader converts its native completion evidence
into a backend-neutral logical-turn IR; each target backend Writer converts that IR into target-native
records. Backend-native logs are never parsed by another backend. The normal turn output envelope is
not used; success is exactly one JSON line under `seed`.

All native source/target routes use that same IR boundary; there are no pair-specific direct
converters:

| Source → Target | Claude | Codex | Kiro | OpenCode |
|---|:---:|:---:|:---:|:---:|
| Claude | ✓ | ✓ | ✓ | ✓ |
| Codex | ✓ | ✓ | ✓ | ✓ |
| Kiro | ✓ | ✓ | ✓ | ✓ |
| OpenCode | ✓ | ✓ | ✓ | ✓ |

Strict external IR v1 enters at the same logical-turn boundary and can create a session for any of
the four targets.

OpenCode native-session reading currently accepts only the verified `info.version == "1.17.11"`
export format. Missing or different export versions fail closed instead of being guessed compatible.

Create a new target session from a native source:

```bash
openp seed codex --source-backend claude --source-session <claude-session-id>
```

Create with a caller operation id so stdout loss or a retry can recover the same result without a
second target bootstrap:

```bash
openp seed codex --source-backend claude --source-session <claude-session-id> \
  --operation-id 11111111-1111-4111-8111-111111111111
openp seed-status 11111111-1111-4111-8111-111111111111
```

Append only the missing logical suffix to an existing target session:

```bash
openp seed kiro --resume <kiro-session-id> \
  --source-backend codex --source-session <codex-session-id>
```

Import a strict external IR document into a new target session:

```bash
openp seed claude --input-ir ./turns.ir.json
```

External IR v1:

```json
{
  "schemaVersion": 1,
  "turns": [
    {
      "id": "caller-stable-id",
      "user": {"text": "Remember the project codename is BLUEFIN."},
      "assistant": {"text": "Noted."}
    }
  ]
}
```

The IR file must be valid UTF-8; malformed byte sequences are rejected before JSON parsing or
document hashing. `--input-ir` is create-only and cannot be combined with `--resume`. `--history` is not supported.
In create mode, `--model`, `--effort`, and `--timeout` apply to the target bootstrap turn. In append
mode, those options are rejected.

Example success output:

```json
{"seed":{"source":{"kind":"native","backend":"claude","sessionId":"..."},"target":{"backend":"codex","sessionId":"..."},"appendedTurns":2,"mode":"create","status":"created"}}
```

`status` is `created`, `updated`, or `noop`. If the source and target logical turn sequences have
diverged, or a backend session contains compaction/rollback/revert state that cannot be converted
safely, seeding fails closed without guessing a transcript.

When `--operation-id` is present, the seed success stdout remains the same `{"seed": ...}` line.
The operation id is a workspace-scoped permanent idempotency tombstone, not a secret. Replaying a
succeeded native-source operation returns the durable result without reading the source backend.
`seed-status` prints exactly one JSON line under `seedOperation`; unknown or corrupt receipts exit
20 without stdout. If a previous owner stopped after `creating` was durably recorded but before a
recoverable target id existed, the operation becomes `indeterminate` and exits 20 instead of making
a second bootstrap. `seed-status` is a reserved top-level command and cannot be used as a configured
backend instance id; rename an existing instance with that id before upgrading to 0.24.0.

Before reporting success, `openp` re-reads the target through its native Reader and durably records
the logical-to-native mapping. If an append is interrupted after the complete native suffix lands,
the next seed access or ordinary resume settles that exact suffix without replaying it; partial or
conflicting native state—including a trailing incomplete record hidden from the logical-turn view—
fails closed instead of being repaired by inference. A pending v2 state marker blocks an older
client from resuming across that settlement boundary. Backend transient import artifacts are tracked
only by an opaque cleanup token (never a transcript or path), cleaned immediately when possible, and
cleaned again during exact recovery before the pending state is retired.

## Timeout and Interrupt

No default timeout. Set one explicitly:

```bash
openp claude --timeout 60 "prompt"
```

`--timeout 0` disables it. Ctrl-C sends graceful interruption; repeated Ctrl-C escalates.

## Options

| Option | Purpose |
|---|---|
| `--resume <session-id>` | Resume a previous session |
| `--timeout <seconds>` | Per-turn wall-clock timeout |
| `--input-format <fmt>` | `text` or `stream-json` |
| `--output-format <fmt>` | `text`, `json`, or `stream-json` |
| `--model <model>` | Backend model selection |
| `--effort <level>` | Reasoning effort where supported |
| `--tools <tools>` | Tool allowlist where supported |
| `--json-schema <json>` | Structured output schema where supported |
| `--streaming` | Active-turn streaming opt-in |
| `--dangerously-skip-permissions` | Trust backend tool execution |
| `--run-id <id>` | Caller-supplied invocation identifier for external process discovery |
| `--event-log <path>` | Mirror stream-json records plus run lifecycle/activity records to a caller-owned file |
| `--debug-log` | Write diagnostics to the open-p state log |
| `--verbose` | Include diagnostic markers in output |

Options may appear before or after the backend name. Only the options listed above are the public `openp` interface.

Backend-native flags that are not listed above fail closed instead of being ignored or passed through. This includes Claude print-mode and raw Claude configuration flags such as `-p`, `--print`, `--include-partial-messages`, `--brief`, `--permission-mode`, `--allowedTools`, `--allowed-tools`, `--disallowedTools`, `--disallowed-tools`, `--mcp-config`, `--settings`, `--setting-sources`, and `--add-dir`.

Use `--tools` for the public tool-policy selector and `--dangerously-skip-permissions` for the public trusted-tool intent. The selected backend may still reject a public option when it does not support that feature.

## Stream-JSON Input

For programmatic use, send structured input on stdin:

```bash
printf '{"type":"user","message":{"content":"hello"}}\n' \
  | openp claude --input-format stream-json --output-format stream-json
```

## Diagnostics

`--debug-log` writes to:

```
${XDG_STATE_HOME:-~/.local/state}/open-p/workspaces/<workspace-hash>/logs/debug.jsonl
```

Debug logs may contain session ids, prompts, response previews, and error context.

`--event-log` writes caller-owned lifecycle records under `openpRun`. The first record contains
`openpRun.header`, the final record contains `openpRun.terminal`, and long-running backend waits
may emit `openpRun.activity` records such as Claude session-log wait stage and idle duration.
New event-log files are created with normal caller ownership and the caller's umask. Existing
caller-owned event-log files keep their current mode and ACL; open-p never tightens or rewrites
the file permissions.

`--verbose` adds diagnostic markers to output. In text mode, a marker line is appended after the answer. In JSON modes, warnings appear under `openp.metadata.warnings`.

## License

MIT
