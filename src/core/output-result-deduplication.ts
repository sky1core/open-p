import {
  buildOpenPResultOutput,
  compactRecord,
  recordArray,
  stringArray,
  type OpenPResultOutput,
} from './output-records.js';

export function dedupeOpenPAssistantResultEvents(
  events: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Map<string, number>();
  const output: Record<string, unknown>[] = [];
  for (const event of events) {
    const key = resultDeduplicationKey(event);
    if (!key) {
      output.push(event);
      continue;
    }
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      output[existingIndex] = mergeResultEvents(output[existingIndex]!, event);
      continue;
    }
    seen.set(key, output.length);
    output.push(event);
  }
  return output;
}

function resultDeduplicationKey(event: Record<string, unknown>): string | null {
  if (event.form !== 'result') {
    return null;
  }
  const metadata = asRecord(event.metadata) ?? {};
  return JSON.stringify({
    form: event.form,
    output: event.output,
    structuredOutput: event.structuredOutput,
    messageId: metadata.messageId,
    requestId: metadata.requestId,
    nativePhase: metadata.nativePhase,
    stopReason: metadata.stopReason,
  });
}

function mergeResultEvents(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): Record<string, unknown> {
  return compactRecord({
    ...second,
    ...first,
    output: mergeResultOutput(first.output, second.output),
    metadata: mergeMetadataField(first.metadata, second.metadata),
  });
}

function mergeResultOutput(first: unknown, second: unknown): OpenPResultOutput {
  const firstOutput = asRecord(first) ?? {};
  const secondOutput = asRecord(second) ?? {};
  return buildOpenPResultOutput({
    answer: mergeStringField(firstOutput.answer, secondOutput.answer),
    reasoning: mergeStringField(firstOutput.reasoning, secondOutput.reasoning),
    toolCall: mergeRecordField(firstOutput.toolCall, secondOutput.toolCall),
    toolResult: mergeRecordField(firstOutput.toolResult, secondOutput.toolResult),
  });
}

function mergeStringField(first: unknown, second: unknown): string[] {
  return dedupeValues([
    ...stringArray(first),
    ...stringArray(second),
  ], (value) => value);
}

function mergeRecordField(first: unknown, second: unknown): Record<string, unknown>[] {
  return dedupeValues([
    ...recordArray(Array.isArray(first) ? first : []),
    ...recordArray(Array.isArray(second) ? second : []),
  ], (value) => JSON.stringify(value));
}

function dedupeValues<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const output: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function mergeMetadataField(first: unknown, second: unknown): Record<string, unknown> | undefined {
  const firstMetadata = asRecord(first) ?? {};
  const secondMetadata = asRecord(second) ?? {};
  const output: Record<string, unknown> = { ...secondMetadata };
  for (const [key, value] of Object.entries(firstMetadata)) {
    if (value !== undefined && value !== null) {
      output[key] = value;
    } else if (!Object.prototype.hasOwnProperty.call(output, key)) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
