import { EXIT_CODES, OpenPError } from '../../core/errors.js';

export interface KiroAcpArgsOptions {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly executionMode?: string | null;
  readonly nativeExecutionMode?: string | null;
  readonly tools?: string | null;
  readonly backendArgs?: readonly string[] | null;
}

export interface KiroAcpArgsResult {
  readonly args: readonly string[];
  readonly trustAllTools: boolean;
}

export function buildKiroAcpArgs(options: KiroAcpArgsOptions): KiroAcpArgsResult {
  const args: string[] = ['acp'];
  if (options.model !== null && options.model !== undefined && options.model.length > 0) {
    args.push('--model', options.model);
  }
  if (options.reasoningEffort !== null && options.reasoningEffort !== undefined && options.reasoningEffort.length > 0) {
    args.push('--effort', options.reasoningEffort);
  }

  const tools = options.tools;
  const toolsProvided = tools !== null && tools !== undefined;
  // Kiro has no permission-mode selector: --trust-all-tools is one boolean and --trust-tools names
  // individual tools. Neither is a mode, so a native value has nowhere to land.
  if (options.nativeExecutionMode) {
    throw new OpenPError('Kiro has no permission mode selector', EXIT_CODES.unsupportedOption);
  }
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
