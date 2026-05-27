import { EXIT_CODES, OpenPError } from './errors.js';

export interface StreamingResultDiagnosticInput {
  readonly streamingAnswerTexts?: readonly string[];
  readonly streamingAnswerTextStreams?: readonly (readonly string[])[];
  readonly resultAnswerText: string;
  readonly streamingReasoningTexts?: readonly string[];
  readonly streamingReasoningTextStreams?: readonly (readonly string[])[];
  readonly resultReasoningText?: string | null;
}

export interface StreamingResultDiagnosticViolation {
  readonly kind:
    | 'streaming-answer-not-cumulative'
    | 'streaming-answer-outside-result'
    | 'streaming-reasoning-not-cumulative'
    | 'streaming-reasoning-outside-result';
  readonly message: string;
  readonly streamIndex: number;
  readonly snapshotIndex: number;
  readonly previousLength?: number;
  readonly streamingLength: number;
  readonly resultLength?: number;
  readonly previousPreview?: string;
  readonly streamingPreview: string;
  readonly resultPreview?: string;
}

export class StreamingResultDiagnosticTracker {
  private readonly streamingAnswerTextStreams: string[][] = [[]];
  private readonly streamingReasoningTextStreams: string[][] = [[]];

  startNewMessage(): void {
    if (this.currentAnswerTextStream().length > 0) {
      this.streamingAnswerTextStreams.push([]);
    }
    if (this.currentReasoningTextStream().length > 0) {
      this.streamingReasoningTextStreams.push([]);
    }
  }

  recordAnswerText(text: string): void {
    if (text.length > 0) {
      this.currentAnswerTextStream().push(text);
    }
  }

  recordReasoningText(text: string): void {
    if (text.length > 0) {
      this.currentReasoningTextStream().push(text);
    }
  }

  assertCompatible(resultAnswerText: string, resultReasoningText?: string | null): void {
    assertStreamingResultCompatibility({
      streamingAnswerTextStreams: this.streamingAnswerTextStreams,
      resultAnswerText,
      streamingReasoningTextStreams: this.streamingReasoningTextStreams,
      resultReasoningText,
    });
  }

  findViolations(resultAnswerText: string, resultReasoningText?: string | null): readonly StreamingResultDiagnosticViolation[] {
    return findStreamingResultDiagnosticViolations({
      streamingAnswerTextStreams: this.streamingAnswerTextStreams,
      resultAnswerText,
      streamingReasoningTextStreams: this.streamingReasoningTextStreams,
      resultReasoningText,
    });
  }

  private currentAnswerTextStream(): string[] {
    const stream = this.streamingAnswerTextStreams.at(-1);
    if (stream) {
      return stream;
    }
    const next: string[] = [];
    this.streamingAnswerTextStreams.push(next);
    return next;
  }

  private currentReasoningTextStream(): string[] {
    const stream = this.streamingReasoningTextStreams.at(-1);
    if (stream) {
      return stream;
    }
    const next: string[] = [];
    this.streamingReasoningTextStreams.push(next);
    return next;
  }
}

export function assertStreamingResultCompatibility(input: StreamingResultDiagnosticInput): void {
  const violation = findStreamingResultDiagnosticViolations(input)[0];
  if (violation) {
    throw new OpenPError(violation.message, EXIT_CODES.protocolViolation);
  }
}

export function findStreamingResultDiagnosticViolations(
  input: StreamingResultDiagnosticInput,
): readonly StreamingResultDiagnosticViolation[] {
  const violations: StreamingResultDiagnosticViolation[] = [];
  const answerStreams = normalizeStreams(input.streamingAnswerTextStreams, input.streamingAnswerTexts);
  for (const [streamIndex, stream] of answerStreams.entries()) {
    violations.push(...findCumulativeStreamingTextViolations(stream, 'answer', streamIndex));
    for (const [snapshotIndex, streamingText] of stream.entries()) {
      if (!isTextSubsetOfResult(streamingText, input.resultAnswerText)) {
        violations.push({
          kind: 'streaming-answer-outside-result',
          message: 'streaming answer snapshot is not a prefix/subset of the result answer',
          streamIndex,
          snapshotIndex,
          streamingLength: streamingText.length,
          resultLength: input.resultAnswerText.length,
          streamingPreview: previewText(streamingText),
          resultPreview: previewText(input.resultAnswerText),
        });
      }
    }
  }

  const resultReasoningText = input.resultReasoningText ?? '';
  const reasoningStreams = normalizeStreams(input.streamingReasoningTextStreams, input.streamingReasoningTexts);
  for (const [streamIndex, stream] of reasoningStreams.entries()) {
    violations.push(...findCumulativeStreamingTextViolations(stream, 'reasoning', streamIndex));
    for (const [snapshotIndex, streamingText] of stream.entries()) {
      if (!isTextSubsetOfResult(streamingText, resultReasoningText)) {
        violations.push({
          kind: 'streaming-reasoning-outside-result',
          message: 'streaming reasoning snapshot is not a prefix/subset of the result reasoning',
          streamIndex,
          snapshotIndex,
          streamingLength: streamingText.length,
          resultLength: resultReasoningText.length,
          streamingPreview: previewText(streamingText),
          resultPreview: previewText(resultReasoningText),
        });
      }
    }
  }

  return violations;
}

function normalizeStreams(
  streams: readonly (readonly string[])[] | undefined,
  flatTexts: readonly string[] | undefined,
): readonly (readonly string[])[] {
  if (streams) {
    return streams;
  }
  return flatTexts ? [flatTexts] : [];
}

function findCumulativeStreamingTextViolations(
  streamingTexts: readonly string[],
  kind: 'answer' | 'reasoning',
  streamIndex: number,
): readonly StreamingResultDiagnosticViolation[] {
  const violations: StreamingResultDiagnosticViolation[] = [];
  let previous = '';
  for (const [snapshotIndex, streamingText] of streamingTexts.entries()) {
    if (previous && !streamingText.startsWith(previous)) {
      violations.push({
        kind: kind === 'answer' ? 'streaming-answer-not-cumulative' : 'streaming-reasoning-not-cumulative',
        message: `streaming ${kind} snapshots are not cumulative`,
        streamIndex,
        snapshotIndex,
        previousLength: previous.length,
        streamingLength: streamingText.length,
        previousPreview: previewText(previous),
        streamingPreview: previewText(streamingText),
      });
    }
    previous = streamingText;
  }
  return violations;
}

function isTextSubsetOfResult(streamingText: string, resultText: string): boolean {
  return streamingText.length === 0 || resultText.startsWith(streamingText);
}

function previewText(text: string): string {
  const maxLength = 240;
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, 160)}...[${text.length - 220} chars omitted]...${text.slice(-60)}`;
}
