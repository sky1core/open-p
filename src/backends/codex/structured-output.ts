import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { parseJsonSchemaText, validateStructuredOutput } from '../../core/json-schema.js';

export function parseCodexStructuredOutputSchema(schemaText: string | null): unknown | null {
  return schemaText ? parseJsonSchemaText(schemaText) : null;
}

export function parseCodexStructuredOutputFallback(
  text: string,
  schema: unknown | null,
  turnId: string,
): unknown | undefined {
  if (!schema) {
    return undefined;
  }

  const candidate = extractStructuredOutputCandidate(text);
  if (candidate.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new OpenPError(`structured output for turn ${turnId} was not valid JSON`, EXIT_CODES.protocolViolation);
  }

  validateStructuredOutput(parsed, schema, turnId);
  return parsed;
}

function extractStructuredOutputCandidate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';

  const fenceRegex = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
  let lastFence: RegExpExecArray | null = null;
  let m;
  while ((m = fenceRegex.exec(trimmed)) !== null) lastFence = m;
  if (lastFence?.[1]?.trim()) return lastFence[1].trim();

  if (trimmed[0] === '{' || trimmed[0] === '[') return trimmed;

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ch = lines[i][0];
    if (ch === '{' || ch === '[') {
      const candidate = lines.slice(i).join('\n').trim();
      try { JSON.parse(candidate); return candidate; } catch { /* try earlier line */ }
    }
  }

  return trimmed;
}
