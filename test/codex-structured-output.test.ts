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

test('extracts JSON after prose text', () => {
  const text = 'Let me analyze the code...\nChecking files...\n{"name":"extracted"}';
  const result = parseCodexStructuredOutputFallback(text, SCHEMA, 't1');
  assert.deepEqual(result, { name: 'extracted' });
});

test('extracts JSON after blank-line-separated prose', () => {
  const text = 'Analysis complete.\n\n{"name":"result"}';
  const result = parseCodexStructuredOutputFallback(text, SCHEMA, 't1');
  assert.deepEqual(result, { name: 'result' });
});

test('extracts fenced JSON that does not wrap entire text', () => {
  const text = 'Here is the result:\n\n```json\n{"name":"fenced"}\n```';
  const result = parseCodexStructuredOutputFallback(text, SCHEMA, 't1');
  assert.deepEqual(result, { name: 'fenced' });
});

test('extracts multi-line JSON after prose', () => {
  const text = 'Done.\n{\n  "name": "multi"\n}';
  const result = parseCodexStructuredOutputFallback(text, SCHEMA, 't1');
  assert.deepEqual(result, { name: 'multi' });
});

test('handles unindented inner braces in multi-line JSON after prose', () => {
  const schema = parseCodexStructuredOutputSchema('{"type":"object","properties":{"name":{"type":"string"},"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"number"}}}}}}');
  const text = 'Done.\n{\n"name": "test",\n"items": [\n{\n"id": 1\n}\n]\n}';
  const result = parseCodexStructuredOutputFallback(text, schema, 't1');
  assert.deepEqual(result, { name: 'test', items: [{ id: 1 }] });
});
