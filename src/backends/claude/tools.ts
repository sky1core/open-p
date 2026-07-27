export function buildClaudeToolsArgs(tools: string | null | undefined): string[] {
  return tools === null || tools === undefined ? [] : ['--tools', tools];
}
