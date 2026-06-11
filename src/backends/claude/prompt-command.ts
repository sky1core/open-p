export function extractPromptLocalCommandName(prompt: string): string | null {
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? '';
  const firstToken = firstLine.trimStart().split(/\s+/, 1)[0] ?? '';
  return firstToken.startsWith('/') ? firstToken : null;
}
