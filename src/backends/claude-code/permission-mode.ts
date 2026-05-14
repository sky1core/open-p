const READ_ONLY_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob']);
const TOOL_FLAGS = new Set(['--tools', '--allowedTools', '--allowed-tools']);

export function resolveInteractivePermissionMode(input: {
  readonly permissionMode: string | null;
  readonly backendArgs: readonly string[];
}): string | null {
  if (input.permissionMode !== 'plan') {
    return input.permissionMode;
  }
  return hasOnlyReadOnlyToolAllowlist(input.backendArgs) ? 'acceptEdits' : 'plan';
}

function hasOnlyReadOnlyToolAllowlist(args: readonly string[]): boolean {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg && TOOL_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return false;
      }
      values.push(value);
      index += 1;
    }
  }
  if (values.length === 0) {
    return false;
  }
  const toolNames = values.flatMap((value) => value.split(',').map((tool) => tool.trim()).filter(Boolean));
  return toolNames.length > 0 && toolNames.every((tool) => READ_ONLY_TOOL_NAMES.has(tool));
}
