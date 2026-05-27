import { EXIT_CODES, OpenPError } from '../../core/errors.js';

export interface CodexArgsOptions {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly executionMode?: string | null;
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

export function buildFirstTurnArgs(prompt: string, options: CodexArgsOptions): string[] {
  const args: string[] = [];

  rejectUnsupportedTools(options.tools);
  appendSandboxArgs(args, options.executionMode);

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

  args.push(prompt);
  return args;
}

export function buildResumeTurnArgs(sessionId: string, prompt: string, options: CodexArgsOptions): string[] {
  const args: string[] = [];

  rejectUnsupportedTools(options.tools);
  appendResumeSandboxArgs(args, options.executionMode);

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

  args.push(sessionId, prompt);
  return args;
}

function appendSandboxArgs(args: string[], executionMode: string | null | undefined): void {
  const mode = executionMode?.trim() || null;

  if (!mode || mode === 'default') {
    return;
  }

  if (mode === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
    return;
  }

  if (mode === 'read-only' || mode === 'workspace-write') {
    args.push('--sandbox', mode, '--ask-for-approval', 'never');
    return;
  }

  throw new OpenPError(`unsupported Codex execution mode: ${mode}`, EXIT_CODES.unsupportedOption);
}

function appendResumeSandboxArgs(args: string[], executionMode: string | null | undefined): void {
  const mode = executionMode?.trim() || null;

  if (!mode || mode === 'default') {
    return;
  }

  if (mode === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
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
  const effort = reasoningEffort?.trim() || null;
  if (effort) {
    appendConfigOverride(args, 'model_reasoning_effort', effort);
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
