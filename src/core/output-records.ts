export type OpenPResultOutput = {
  answer: string[];
  reasoning: string[];
  toolCall: Record<string, unknown>[];
  toolResult: Record<string, unknown>[];
};

type OpenPOutputKey = keyof OpenPResultOutput;

export function buildOpenPResultOutput(
  input: Partial<Record<OpenPOutputKey, unknown>> = {},
): OpenPResultOutput {
  return {
    answer: stringArray(input.answer),
    reasoning: stringArray(input.reasoning),
    toolCall: recordArray(input.toolCall),
    toolResult: recordArray(input.toolResult),
  };
}

export function stringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function recordArray(value: unknown): Record<string, unknown>[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [value as Record<string, unknown>];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => (
    Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  ));
}

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}
