import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { validateKiroReasoningEffort } from './effort.js';

export interface KiroAcpArgsOptions {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly executionMode?: string | null;
  readonly tools?: string | null;
  readonly backendArgs?: readonly string[] | null;
}

export interface KiroAcpArgsResult {
  readonly args: readonly string[];
  readonly trustAllTools: boolean;
}

export function buildKiroAcpArgs(options: KiroAcpArgsOptions): KiroAcpArgsResult {
  const args: string[] = ['acp'];
  const model = options.model?.trim() || null;
  if (model) {
    args.push('--model', model);
  }
  const effort = validateKiroReasoningEffort(options.reasoningEffort);
  if (effort) {
    args.push('--effort', effort);
  }

  const tools = options.tools;
  const toolsProvided = tools !== null && tools !== undefined;
  const trustAllToolsRequested = resolveTrustAllTools(options.executionMode);
  const trustAllTools = !toolsProvided && trustAllToolsRequested;
  if (toolsProvided && tools.length > 0) {
    args.push('--trust-tools', tools);
  } else if (trustAllTools) {
    args.push('--trust-all-tools');
  }

  validateNoBackendArgs(options.backendArgs ?? []);
  return { args, trustAllTools };
}

function resolveTrustAllTools(executionMode: string | null | undefined): boolean {
  const mode = executionMode?.trim() || null;
  if (!mode || mode === 'default') {
    return false;
  }
  if (mode === 'danger-full-access') {
    return true;
  }
  throw new OpenPError(`unsupported Kiro execution mode: ${mode}`, EXIT_CODES.unsupportedOption);
}

function validateNoBackendArgs(backendArgs: readonly string[]): void {
  for (let index = 0; index < backendArgs.length; index += 1) {
    const arg = backendArgs[index]!;
    throw new OpenPError(`unsupported Kiro backend argument: ${arg}`, EXIT_CODES.unsupportedOption);
  }
}
