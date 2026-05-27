const READ_ONLY_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoRead']);

export function buildClaudeToolsArgs(tools: string | null | undefined): string[] {
  return tools === null || tools === undefined ? [] : ['--tools', tools];
}

export function toolNamesAreReadOnly(toolNames: readonly string[]): boolean {
  return toolNames.length > 0 && toolNames.every((tool) => READ_ONLY_TOOL_NAMES.has(tool));
}

export function parseToolNames(tools: string): string[] {
  return tools
    .split(/[\s,]+/u)
    .map((tool) => tool.trim())
    .filter(Boolean);
}
