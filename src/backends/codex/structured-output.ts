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
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}
