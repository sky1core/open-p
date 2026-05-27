import { parseToolNames, toolNamesAreReadOnly } from './tools.js';

const TOOL_FLAGS = new Set(['--tools', '--allowedTools', '--allowed-tools']);

export function resolveInteractivePermissionMode(input: {
  readonly permissionMode: string | null;
  readonly tools?: string | null;
  readonly backendArgs: readonly string[];
}): string | null {
  if (input.permissionMode === 'danger-full-access') {
    return 'bypassPermissions';
  }
  if (input.permissionMode !== 'plan') {
    return input.permissionMode;
  }
  return explicitToolPolicyIsReadOnly(input.tools, input.backendArgs) ? 'acceptEdits' : 'plan';
}

function explicitToolPolicyIsReadOnly(tools: string | null | undefined, args: readonly string[]): boolean {
  const toolNames = [
    ...parseStructuredToolNames(tools),
    ...parseBackendToolNames(args),
  ];
  return toolNamesAreReadOnly(toolNames);
}

function parseStructuredToolNames(tools: string | null | undefined): string[] {
  return tools === null || tools === undefined ? [] : parseToolNames(tools);
}

function parseBackendToolNames(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    const equalIndex = arg.indexOf('=');
    const flag = equalIndex >= 0 ? arg.slice(0, equalIndex) : arg;
    if (!TOOL_FLAGS.has(flag)) {
      continue;
    }
    if (equalIndex >= 0) {
      values.push(arg.slice(equalIndex + 1));
    } else {
      const value = args[index + 1];
      if (value !== undefined) {
        values.push(value);
        index += 1;
      }
    }
  }
  return values.flatMap((value) => parseToolNames(value));
}
