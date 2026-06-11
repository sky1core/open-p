export function isKiroSlashCommandPrompt(prompt: string): boolean {
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? '';
  const firstToken = firstLine.trimStart().split(/\s+/, 1)[0] ?? '';
  return firstToken.startsWith('/');
}
