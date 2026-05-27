import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStreamingResultCompatibility,
  findStreamingResultDiagnosticViolations,
  StreamingResultDiagnosticTracker,
} from '../src/core/streaming-result-diagnostics.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

test('streaming-result diagnostics accept cumulative answer snapshots and equal result text', () => {
  assertStreamingResultCompatibility({
    streamingAnswerTexts: ['A', 'A\n\nB', 'A\n\nB\n\nC'],
    resultAnswerText: 'A\n\nB\n\nC',
    streamingReasoningTexts: [],
    resultReasoningText: null,
  });
});

test('streaming-result diagnostics reject answer snapshots outside result text', () => {
  assert.throws(
    () => assertStreamingResultCompatibility({
      streamingAnswerTexts: ['progress', 'progress\n\nfinal'],
      resultAnswerText: 'final',
      streamingReasoningTexts: [],
      resultReasoningText: null,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('streaming-result diagnostics reject non-cumulative answer snapshots', () => {
  assert.throws(
    () => assertStreamingResultCompatibility({
      streamingAnswerTexts: ['AB', 'A'],
      resultAnswerText: 'ABC',
      streamingReasoningTexts: [],
      resultReasoningText: null,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('streaming-result diagnostics reject reasoning snapshots without result reasoning source', () => {
  const tracker = new StreamingResultDiagnosticTracker();
  tracker.recordReasoningText('thinking draft');

  assert.throws(
    () => tracker.assertCompatible('answer', null),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('streaming-result diagnostics reset cumulative answer checks across message boundaries', () => {
  const tracker = new StreamingResultDiagnosticTracker();
  tracker.recordAnswerText('first');
  tracker.startNewMessage();
  tracker.recordAnswerText('second');

  const violations = tracker.findViolations('first and second', null);

  assert.equal(
    violations.some((violation) => violation.kind === 'streaming-answer-not-cumulative'),
    false,
  );
  assert.equal(
    violations.some((violation) => violation.kind === 'streaming-answer-outside-result'),
    true,
  );
});

test('streaming-result diagnostics split answer and reasoning streams independently', () => {
  const tracker = new StreamingResultDiagnosticTracker();
  tracker.recordAnswerText('answer draft');
  tracker.recordReasoningText('reasoning');
  tracker.startNewMessage();
  tracker.recordAnswerText('answer');

  const violations = tracker.findViolations('answer', 'reasoning');

  assert.equal(
    violations.some((violation) => violation.kind === 'streaming-answer-not-cumulative'),
    false,
  );
  assert.equal(
    violations.some((violation) => violation.kind === 'streaming-reasoning-not-cumulative'),
    false,
  );
  assert.equal(
    violations.some((violation) => violation.kind === 'streaming-reasoning-outside-result'),
    false,
  );
});

test('streaming-result diagnostics keep flat input behavior for direct helper callers', () => {
  const violations = findStreamingResultDiagnosticViolations({
    streamingAnswerTexts: ['AB', 'A'],
    resultAnswerText: 'ABC',
    streamingReasoningTexts: [],
    resultReasoningText: null,
  });

  assert.equal(violations[0]?.kind, 'streaming-answer-not-cumulative');
});
