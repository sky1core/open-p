import { EXIT_CODES, OpenPError } from '../../core/errors.js';

const CODEX_UNRESTRICTED_MODE_FLAG = '--dangerously-bypass-approvals-and-sandbox';

export interface CodexArgsOptions {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly executionMode?: string | null;
  readonly nativeExecutionMode?: string | null;
  readonly tools?: string | null;
  readonly outputLastMessagePath: string;
  readonly outputSchemaPath?: string | null;
  readonly cwd?: string | null;
}

export function validateCodexBackendArgs(backendArgs: readonly string[]): void {
  for (let index = 0; index < backendArgs.length; index += 1) {
    const arg = backendArgs[index]!;
    throw new OpenPError(`Codex backend does not support backend argument ${arg}`, EXIT_CODES.unsupportedOption);
  }
}

export function buildFirstTurnArgs(options: CodexArgsOptions): string[] {
  const args: string[] = [];

  rejectUnsupportedTools(options.tools);
  appendSandboxArgs(args, options.executionMode, options.nativeExecutionMode);

  args.push('exec');
  args.push('--skip-git-repo-check', '--json');
  args.push('--output-last-message', options.outputLastMessagePath);

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.cwd) {
    args.push('-C', options.cwd);
  }

  appendReasoningEffortArgs(args, options.reasoningEffort);

  if (options.outputSchemaPath) {
    args.push('--output-schema', options.outputSchemaPath);
  }

  args.push('-');
  return args;
}

export function buildResumeTurnArgs(sessionId: string, options: CodexArgsOptions): string[] {
  const args: string[] = [];

  rejectUnsupportedTools(options.tools);
  appendResumeSandboxArgs(args, options.executionMode, options.nativeExecutionMode);

  args.push('exec', 'resume');
  args.push('--skip-git-repo-check', '--json');
  args.push('--output-last-message', options.outputLastMessagePath);

  if (options.model) {
    args.push('--model', options.model);
  }

  appendReasoningEffortArgs(args, options.reasoningEffort);

  if (options.outputSchemaPath) {
    args.push('--output-schema', options.outputSchemaPath);
  }

  args.push(sessionId, '-');
  return args;
}

function appendSandboxArgs(
  args: string[],
  executionMode: string | null | undefined,
  nativeExecutionMode?: string | null,
): void {
  // A native mode is Codex's own sandbox value and goes through unread; Codex owns whether it is one
  // it knows. Approval stays pinned because `codex exec` has no flag for it and a policy that asks
  // hands the refused call back to the model instead of prompting.
  if (nativeExecutionMode) {
    args.push('--sandbox', nativeExecutionMode, '--ask-for-approval', 'never');
    return;
  }
  const mode = executionMode?.trim() || null;

  if (!mode || mode === 'default') {
    return;
  }

  if (mode === 'danger-full-access') {
    args.push(CODEX_UNRESTRICTED_MODE_FLAG);
    return;
  }

  if (mode === 'read-only' || mode === 'workspace-write') {
    args.push('--sandbox', mode, '--ask-for-approval', 'never');
    return;
  }

  throw new OpenPError(`unsupported Codex execution mode: ${mode}`, EXIT_CODES.unsupportedOption);
}

function appendResumeSandboxArgs(
  args: string[],
  executionMode: string | null | undefined,
  nativeExecutionMode?: string | null,
): void {
  // `codex exec resume` has no --sandbox flag, so the same selection travels as a config override.
  if (nativeExecutionMode) {
    appendConfigOverride(args, 'sandbox_mode', nativeExecutionMode);
    appendConfigOverride(args, 'approval_policy', 'never');
    return;
  }
  const mode = executionMode?.trim() || null;

  if (!mode || mode === 'default') {
    return;
  }

  if (mode === 'danger-full-access') {
    args.push(CODEX_UNRESTRICTED_MODE_FLAG);
    return;
  }

  if (mode === 'read-only' || mode === 'workspace-write') {
    appendConfigOverride(args, 'sandbox_mode', mode);
    appendConfigOverride(args, 'approval_policy', 'never');
    return;
  }

  throw new OpenPError(`unsupported Codex execution mode: ${mode}`, EXIT_CODES.unsupportedOption);
}

function appendReasoningEffortArgs(args: string[], reasoningEffort: string | null | undefined): void {
  if (reasoningEffort !== null && reasoningEffort !== undefined && reasoningEffort.length > 0) {
    appendConfigOverride(args, 'model_reasoning_effort', reasoningEffort);
  }
}

function rejectUnsupportedTools(tools: string | null | undefined): void {
  if (tools !== null && tools !== undefined) {
    throw new OpenPError('Codex backend does not support --tools', EXIT_CODES.unsupportedOption);
  }
}

function appendConfigOverride(args: string[], key: string, value: string): void {
  args.push('-c', `${key}=${JSON.stringify(value)}`);
}
