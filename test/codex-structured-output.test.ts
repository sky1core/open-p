import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexStructuredOutputFallback, parseCodexStructuredOutputSchema } from '../src/backends/codex/structured-output.js';

const SCHEMA = parseCodexStructuredOutputSchema('{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}');

test('returns undefined when schema is null', () => {
  assert.equal(parseCodexStructuredOutputFallback('{"name":"foo"}', null, 't1'), undefined);
});

test('returns undefined when text is empty', () => {
  assert.equal(parseCodexStructuredOutputFallback('', SCHEMA, 't1'), undefined);
});

test('returns undefined when text is whitespace only', () => {
  assert.equal(parseCodexStructuredOutputFallback('   \n  ', SCHEMA, 't1'), undefined);
});

test('parses plain JSON text', () => {
  const result = parseCodexStructuredOutputFallback('{"name":"bar"}', SCHEMA, 't1');
  assert.deepEqual(result, { name: 'bar' });
});

test('extracts JSON from fenced code block', () => {
  const text = '```json\n{"name":"baz"}\n```';
  const result = parseCodexStructuredOutputFallback(text, SCHEMA, 't1');
  assert.deepEqual(result, { name: 'baz' });
});

test('throws on invalid JSON with schema present', () => {
  assert.throws(
    () => parseCodexStructuredOutputFallback('not json', SCHEMA, 't1'),
    /structured output for turn t1 was not valid JSON/,
  );
});
