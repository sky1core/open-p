import assert from 'node:assert/strict';
import test from 'node:test';

const helperPath = '../scripts/stream-json-contract-helpers.mjs';
const {
  incrementalTextReport,
  previewResultCompatibilityReport,
} = await import(helperPath);

test('stream-json contract gate rejects non-monotonic assistant preview sequences', () => {
  const report = incrementalTextReport([
    'a'.repeat(120),
    'a'.repeat(80),
    'a'.repeat(140),
  ]);

  assert.equal(report.incremental, true);
  assert.equal(report.allTextEventsPrefixCompatible, false);
  assert.deepEqual(report.growingPrefixPairs, [false, true]);
  assert.deepEqual(report.regressions, [
    {
      index: 1,
      previousLength: 120,
      currentLength: 80,
      currentStartsWithPrevious: false,
    },
  ]);
});

test('stream-json contract gate accepts monotonic assistant preview growth', () => {
  const report = incrementalTextReport([
    'a'.repeat(80),
    'a'.repeat(120),
    'a'.repeat(140),
  ]);

  assert.equal(report.incremental, true);
  assert.equal(report.allTextEventsPrefixCompatible, true);
  assert.deepEqual(report.growingPrefixPairs, [true, true]);
  assert.deepEqual(report.regressions, []);
});

test('stream-json contract gate requires a substantial result-compatible preview', () => {
  const resultText = `## ${'a'.repeat(90)}`;
  const shortPreview = 'a'.repeat(10);
  const longRenderedPreview = 'a'.repeat(80);

  assert.equal(previewResultCompatibilityReport([shortPreview], resultText).compatible, false);
  assert.equal(previewResultCompatibilityReport([longRenderedPreview], resultText).compatible, true);
});
