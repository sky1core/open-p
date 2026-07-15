interface JsonObject {
  readonly [key: string]: unknown;
}

export function isClaudeCodeApiErrorAssistant(entry: JsonObject): boolean {
  return entry.type === 'assistant' && (
    entry.isApiErrorMessage === true ||
    typeof entry.apiErrorStatus === 'number' ||
    typeof entry.error === 'string' && entry.error.trim().length > 0
  );
}
