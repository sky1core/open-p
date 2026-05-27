#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  incrementalTextReport,
  previewResultCompatibilityReport,
} from './stream-json-contract-helpers.mjs';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(rootDir, 'dist', 'src', 'cli.js');
const args = process.argv.slice(2);
const enabled = args.includes('--run');
const strict = args.includes('--strict');
const timeoutMs = Number.parseInt(readArg('--timeout-ms') ?? '120000', 10);
const claudeBin = readArg('--claude-bin') ?? 'claude';
const model = readArg('--model') ?? 'sonnet';
const effort = readArg('--effort') ?? 'low';

if (!enabled) {
  console.log('Skipping live stream-json contract verification. Run `npm run verify:stream-json-contract -- --run` after `npm run build`.');
  process.exit(0);
}

if (!existsSync(cliPath)) {
  throw new Error('dist/src/cli.js is missing. Run npm run build first.');
}

const schema = JSON.stringify({
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
});
const permissionArgs = ['--dangerously-skip-permissions'];
const reasoningArgs = effort ? ['--effort', effort] : [];

const cases = [
  {
    name: 'json',
    expected: `openp-contract-json-${randomUUID().slice(0, 8)}`,
    claudeArgs: (prompt) => ['-p', '--output-format', 'json', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['claude', '--output-format', 'json', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonObject,
    verify: verifyJsonResult,
  },
  {
    name: 'stream-json',
    expected: `openp-contract-stream-${randomUUID().slice(0, 8)}`,
    claudeArgs: (prompt) => ['-p', '--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['claude', '--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonLines,
    verify: verifyStreamJsonResult,
  },
  {
    name: 'stream-json-streaming',
    expected: `openp-contract-streaming-${randomUUID().slice(0, 8)}`,
    claudeArgs: (prompt) => ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['claude', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonLines,
    verify: verifyStreamingStreamJsonResult,
  },
  {
    name: 'stream-json-structured-streaming',
    expected: '{"ok":true}',
    claudeArgs: (prompt) => ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', schema, ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['claude', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', schema, ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonLines,
    verify: verifyStructuredStreamJsonResult,
  },
  {
    name: 'worker-stream-json',
    expected: `openp-contract-worker-${randomUUID().slice(0, 8)}`,
    claudeArgs: () => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs],
    openpArgs: () => ['claude', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs],
    input: (expected) => JSON.stringify({ type: 'user', message: { role: 'user', content: promptForContract(expected) } }) + '\n',
    parse: parseJsonLines,
    verify: verifyStreamJsonResult,
  },
  {
    name: 'worker-stream-json-streaming',
    expected: `openp-contract-worker-streaming-${randomUUID().slice(0, 8)}`,
    claudeArgs: () => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs],
    openpArgs: () => ['claude', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs],
    input: (expected) => JSON.stringify({ type: 'user', message: { role: 'user', content: promptForContract(expected) } }) + '\n',
    parse: parseJsonLines,
    verify: verifyStreamingStreamJsonResult,
  },
];
const caseFilter = (readArg('--cases') ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const selectedCases = caseFilter.length > 0
  ? cases.filter((testCase) => caseFilter.includes(testCase.name))
  : cases;

if (caseFilter.length > 0 && selectedCases.length !== caseFilter.length) {
  const selectedNames = new Set(selectedCases.map((testCase) => testCase.name));
  const unknown = caseFilter.filter((name) => !selectedNames.has(name));
  throw new Error(`unknown live stream-json contract case(s): ${unknown.join(', ')}`);
}

const report = [];
const requiredFailures = [];

for (const testCase of selectedCases) {
  const prompt = testCase.name === 'stream-json-structured-streaming'
    ? structuredPrompt()
    : promptForContract(testCase.expected);
  const input = testCase.input ? testCase.input(testCase.expected) : '';
  const claudeRaw = await runCommand(claudeBin, testCase.claudeArgs(prompt), input);
  const openpRaw = await runCommand(process.execPath, [cliPath, ...testCase.openpArgs(prompt)], input);
  const claudeParsed = testCase.parse(claudeRaw.stdout);
  const openpParsed = testCase.parse(openpRaw.stdout);

  testCase.verify(testCase, claudeParsed, 'claude');
  testCase.verify(testCase, openpParsed, 'openp');
  verifyCrossContract(testCase, claudeParsed, openpParsed);

  const requiredContractFailures = collectRequiredContractFailures(testCase, {
    claudeParsed,
    openpParsed,
    claudeRaw,
    openpRaw,
  });
  requiredFailures.push(...requiredContractFailures.map((failure) => ({
    name: testCase.name,
    ...failure,
  })));

  const strictGaps = collectStrictShapeGaps(claudeParsed, openpParsed);
  report.push({
    name: testCase.name,
    claude: summarizeOutput(claudeParsed),
    openp: summarizeOutput(openpParsed),
    claudeTiming: resultTiming(claudeRaw.lineArrivals),
    openpTiming: resultTiming(openpRaw.lineArrivals),
    requiredContractFailures,
    strictGaps,
  });
}

const gapCount = report.reduce((sum, item) => sum + item.strictGaps.length, 0);
const requiredContractOk = requiredFailures.length === 0;
console.log(JSON.stringify({
  ok: requiredContractOk && (!strict || gapCount === 0),
  requiredContractOk,
  strict,
  model,
  effort,
  strictGapCount: gapCount,
  report,
}, null, 2));

if (requiredFailures.length > 0) {
  throw new Error(`required stream-json contract comparison found ${requiredFailures.length} failure(s)`);
}

if (strict && gapCount > 0) {
  throw new Error(`strict stream-json shape comparison found ${gapCount} gap(s)`);
}

function promptForContract(expected) {
  return [
    'Analyze the architecture tradeoffs for a multi-backend interactive agent CLI compatibility layer.',
    'Compare PTY-based interactive runners, stdout JSON event protocols, persistent app-server protocols, session resume semantics, structured output validation, and streaming event contracts.',
    'Give a detailed but concise engineering analysis with at least 8 numbered points and a result recommendation.',
    `End the visible result answer with this exact marker: ${expected}`,
    'Do not use markdown tables.',
  ].join('\n');
}

function structuredPrompt() {
  return [
    'Verify that the JSON object has exactly one boolean property named ok and that ok is true.',
    'Then return exactly this JSON object and no extra visible text:',
    '{"ok":true}',
  ].join('\n');
}

function verifyJsonResult(testCase, result, label) {
  if (label === 'openp') {
    verifyOpenPJsonResult(testCase, result, label);
    return;
  }
  assertObject(result, `${label} ${testCase.name}`);
  assertEqual(result.type, 'result', `${label} ${testCase.name} type`);
  assertEqual(result.subtype, 'success', `${label} ${testCase.name} subtype`);
  assertEqual(result.is_error, false, `${label} ${testCase.name} is_error`);
  assertResultEndsWithMarker(result.result, testCase.expected, `${label} ${testCase.name} result`);
  assertNoOpenPOnlyFields(result, `${label} ${testCase.name} result`);
}

function verifyStreamJsonResult(testCase, events, label) {
  if (label === 'openp') {
    verifyOpenPStreamJsonResult(testCase, events, label, { requireStreaming: false });
    return;
  }
  assertArray(events, `${label} ${testCase.name}`);
  const result = findResult(events);
  assertResultEndsWithMarker(result.result, testCase.expected, `${label} ${testCase.name} result`);
  assertHasEvent(events, 'system', `${label} ${testCase.name} system`);
  assertHasEvent(events, 'assistant', `${label} ${testCase.name} assistant`);
  assertAssistantBeforeResult(events, `${label} ${testCase.name}`);
  assertNoOpenPOnlyFieldsDeep(events, `${label} ${testCase.name}`);
}

function verifyStreamingStreamJsonResult(testCase, events, label) {
  if (label === 'openp') {
    verifyOpenPStreamJsonResult(testCase, events, label, { requireStreaming: true });
    return;
  }
  verifyStreamJsonResult(testCase, events, label);
  assertHasStreamEvent(events, 'message_start', `${label} ${testCase.name} message_start`);
  assertHasStreamEvent(events, 'content_block_start', `${label} ${testCase.name} content_block_start`);
  assertHasTextDelta(events, `${label} ${testCase.name} text_delta`);
  assertHasStreamEvent(events, 'content_block_stop', `${label} ${testCase.name} content_block_stop`);
  assertHasStreamEvent(events, 'message_delta', `${label} ${testCase.name} message_delta`);
  assertHasStreamEvent(events, 'message_stop', `${label} ${testCase.name} message_stop`);
}

function verifyStructuredStreamJsonResult(testCase, events, label) {
  if (label === 'openp') {
    verifyOpenPStructuredStreamJsonResult(testCase, events, label);
    return;
  }
  assertArray(events, `${label} ${testCase.name}`);
  assertHasEvent(events, 'system', `${label} ${testCase.name} system`);
  assertHasEvent(events, 'assistant', `${label} ${testCase.name} assistant`);
  assertNoOpenPOnlyFieldsDeep(events, `${label} ${testCase.name}`);
  assertHasStreamEvent(events, 'message_start', `${label} ${testCase.name} message_start`);
  assertHasStreamEvent(events, 'message_delta', `${label} ${testCase.name} message_delta`);
  assertHasStreamEvent(events, 'message_stop', `${label} ${testCase.name} message_stop`);
  const result = findResult(events);
  assertEqual(JSON.stringify(result.structured_output), JSON.stringify({ ok: true }), `${label} ${testCase.name} structured_output`);
}

function verifyOpenPJsonResult(testCase, result, label) {
  assertObject(result, `${label} ${testCase.name}`);
  assertOpenPNativeRecord(result, `${label} ${testCase.name}`);
  const openp = result.openp;
  const allOpenPEvents = collectOpenPEventPayloads(result);
  assertOpenPContractShape(allOpenPEvents, `${label} ${testCase.name}`);
  assertEqual(openp.form, 'result', `${label} ${testCase.name} openp.form`);
  assertResultEndsWithMarker(openPResultText(openp), testCase.expected, `${label} ${testCase.name} openp.output.answer`);
  assertNoLegacyTopLevelFields(result, `${label} ${testCase.name}`);
  for (const event of allOpenPEvents) {
    assertNoForbiddenOpenPFields(event, `${label} ${testCase.name}`);
  }
}

function verifyOpenPStreamJsonResult(testCase, events, label, options) {
  assertArray(events, `${label} ${testCase.name}`);
  assertOpenPNativeRecords(events, `${label} ${testCase.name}`);
  const openpEvents = events.map((event) => event.openp);
  const allOpenPEvents = collectOpenPEventPayloads(events);
  assertOpenPContractShape(allOpenPEvents, `${label} ${testCase.name}`);
  const result = findOpenPTurnResult(openpEvents, `${label} ${testCase.name}`);
  assertEqual(result.form, 'result', `${label} ${testCase.name} result form`);
  assertResultEndsWithMarker(openPResultText(result), testCase.expected, `${label} ${testCase.name} openp.output.answer`);
  if (options.requireStreaming) {
    assertOpenPStreamingTextSnapshots(openpEvents, 'answer', `${label} ${testCase.name}`, { required: true });
    assertOpenPStreamingTextSnapshots(openpEvents, 'reasoning', `${label} ${testCase.name}`, { required: false });
  } else {
    assertNoActiveOpenPStreamingRecords(openpEvents, `${label} ${testCase.name}`);
  }
  assertNoLegacyTopLevelFieldsDeep(events, `${label} ${testCase.name}`);
  for (const openp of allOpenPEvents) {
    assertNoForbiddenOpenPFields(openp, `${label} ${testCase.name}`);
  }
}

function verifyOpenPStructuredStreamJsonResult(testCase, events, label) {
  assertArray(events, `${label} ${testCase.name}`);
  assertOpenPNativeRecords(events, `${label} ${testCase.name}`);
  const openpEvents = events.map((event) => event.openp);
  const allOpenPEvents = collectOpenPEventPayloads(events);
  assertOpenPContractShape(allOpenPEvents, `${label} ${testCase.name}`);
  const result = findOpenPTurnResult(openpEvents, `${label} ${testCase.name}`);
  assertEqual(result.form, 'result', `${label} ${testCase.name} result form`);
  assertEqual(JSON.stringify(result.structuredOutput), JSON.stringify({ ok: true }), `${label} ${testCase.name} structuredOutput`);
  assertOpenPStructuredResultArtifact(openpEvents, allOpenPEvents, `${label} ${testCase.name}`);
  assertNoLegacyTopLevelFieldsDeep(events, `${label} ${testCase.name}`);
  for (const openp of allOpenPEvents) {
    assertNoForbiddenOpenPFields(openp, `${label} ${testCase.name}`);
  }
}

function verifyCrossContract(testCase, claudeValue, openpValue) {
  const claudeResult = resultObject(claudeValue);
  const openpResult = resultObject(openpValue);
  const claudeStructured = Object.prototype.hasOwnProperty.call(claudeResult, 'structured_output')
    ? claudeResult.structured_output
    : null;
  const openpStructured = Object.prototype.hasOwnProperty.call(openpResult, 'structured_output')
    ? openpResult.structured_output
    : null;
  if (claudeStructured === null && openpStructured === null) {
    assertResultEndsWithMarker(claudeResult.result, testCase.expected, `${testCase.name} claude marker`);
    assertResultEndsWithMarker(openpResult.result, testCase.expected, `${testCase.name} openp marker`);
  }
  assertEqual(JSON.stringify(openpStructured), JSON.stringify(claudeStructured), `${testCase.name} cross structured_output`);
}

function collectRequiredContractFailures(testCase, values) {
  if (testCase.name !== 'stream-json' && testCase.name !== 'worker-stream-json') {
    return [];
  }
  const failures = [];
  const openpEvents = rootOpenPEvents(values.openpParsed);
  const resultIndex = openpEvents.findIndex((openp) => openp.form === 'result');
  const openpBeforeResult = resultIndex >= 0 ? openpEvents.slice(0, resultIndex) : openpEvents;
  const openpText = openpBeforeResult
    .filter((openp) => openp.form === 'streaming' && openp.scope === 'active')
    .map((openp) => {
      const output = openPOutput(openp);
      return typeof output.answer === 'string' ? output.answer : '';
    })
    .filter((text) => text.length > 0);
  const openpIncrementalText = incrementalTextReport(openpText);
  if (openpText.length >= 2 && !openpIncrementalText.allTextEventsPrefixCompatible) {
    failures.push({
      kind: 'assistant.text.incremental.openp',
      reason: 'openp emitted multiple assistant text previews before result, but they were not a monotonic growing prefix sequence',
      openp: openpIncrementalText,
    });
  }
  if (openpText.length > 0) {
    failures.push({
      kind: 'assistant.text.default-streaming.openp',
      reason: 'openp default stream-json emitted assistant text before result without --include-partial-messages',
      openp: openpIncrementalText,
    });
  }
  return failures;
}

function rootOpenPEvents(value) {
  assertArray(value, 'openp stream-json events');
  return value
    .map((event) => event?.openp)
    .filter((openp) => openp && typeof openp === 'object' && !Array.isArray(openp));
}

function assistantEventsBeforeResult(events) {
  assertArray(events, 'stream-json events');
  const resultIndex = events.findIndex((event) => event.type === 'result');
  const beforeResult = resultIndex >= 0 ? events.slice(0, resultIndex) : events;
  return beforeResult.filter((event) => event.type === 'assistant');
}

function nonEmptyBlockTexts(events, blockType, field) {
  const texts = [];
  for (const event of events) {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        block.type === blockType &&
        typeof block[field] === 'string' &&
        block[field].length > 0
      ) {
        texts.push(block[field]);
      }
    }
  }
  return texts;
}

function resultTiming(lineArrivals) {
  const firstAssistant = lineArrivals.find((line) => line.type === 'assistant') ?? null;
  const firstTextAssistant = lineArrivals.find((line) => (
    line.type === 'assistant' &&
    Array.isArray(line.contentTypes) &&
    line.contentTypes.includes('text')
  )) ?? null;
  const result = lineArrivals.find((line) => line.type === 'result') ?? null;
  return {
    firstAssistantMs: firstAssistant?.ms ?? null,
    firstAssistantChunkSeq: firstAssistant?.chunkSeq ?? null,
    firstTextAssistantMs: firstTextAssistant?.ms ?? null,
    firstTextAssistantChunkSeq: firstTextAssistant?.chunkSeq ?? null,
    resultMs: result?.ms ?? null,
    resultChunkSeq: result?.chunkSeq ?? null,
    firstAssistantLeadMs: result !== null && firstAssistant !== null ? result.ms - firstAssistant.ms : null,
    firstTextAssistantLeadMs: result !== null && firstTextAssistant !== null ? result.ms - firstTextAssistant.ms : null,
  };
}

function summarizeOutput(value) {
  if (Array.isArray(value)) {
    const compatibilityValue = toCompatibilityValue(value);
    const result = findResult(compatibilityValue);
    const assistantTextBeforeResult = nonEmptyBlockTexts(
      assistantEventsBeforeResult(compatibilityValue),
      'text',
      'text',
    );
    return {
      eventTypes: compatibilityValue.map((event) => event.type),
      openPForms: value.map((event) => event.openp?.form ?? null).filter(Boolean),
      openPScopes: value.map((event) => event.openp?.scope ?? null).filter(Boolean),
      streamEventTypes: compatibilityValue.filter((event) => event.type === 'stream_event').map((event) => event.event?.type),
      assistantContentBeforeResult: assistantEventsBeforeResult(compatibilityValue).map((event) => {
        const content = Array.isArray(event.message?.content) ? event.message.content : [];
        return content.map((block) => ({
          type: block?.type ?? 'unknown',
          textLength: typeof block?.text === 'string' ? block.text.length : null,
          thinkingLength: typeof block?.thinking === 'string' ? block.thinking.length : null,
        }));
      }),
      assistantTextEventsBeforeResult: assistantTextBeforeResult.map((text, index) => ({
        index,
        textLength: text.length,
        text,
      })),
      assistantTextIncremental: incrementalTextReport(assistantTextBeforeResult),
      assistantTextPreviewResultCompatibility: previewResultCompatibilityReport(
        assistantTextBeforeResult,
        result.result,
      ),
      result: result.result,
      structuredOutput: result.structured_output ?? null,
      legacyLeakFields: collectLegacyTopLevelFields(value),
      forbiddenOpenPFields: collectForbiddenOpenPFields(value),
    };
  }
  if (isOpenPNativeRecord(value)) {
    const compatibilityValue = toCompatibilityValue(value);
    return {
      type: compatibilityValue.type,
      openPForm: value.openp.form ?? null,
      openPScope: value.openp.scope ?? null,
      result: compatibilityValue.result,
      structuredOutput: compatibilityValue.structured_output ?? null,
      legacyLeakFields: collectLegacyTopLevelFields(value),
      forbiddenOpenPFields: collectForbiddenOpenPFields(value),
    };
  }
  return {
    type: value.type,
    subtype: value.subtype,
    result: value.result,
    structuredOutput: value.structured_output ?? null,
    openPOnlyFields: collectOpenPOnlyFields(value),
  };
}

function collectStrictShapeGaps(claudeValue, openpValue) {
  const gaps = [];
  const claudeCompatibility = toCompatibilityValue(claudeValue);
  const openpCompatibility = toCompatibilityValue(openpValue);
  const claudeEvents = Array.isArray(claudeCompatibility) ? claudeCompatibility : [claudeCompatibility];
  const openpEvents = Array.isArray(openpCompatibility) ? openpCompatibility : [openpCompatibility];
  const openpByKind = new Map();
  for (const event of openpEvents) {
    const key = eventKind(event);
    if (!openpByKind.has(key)) {
      openpByKind.set(key, []);
    }
    openpByKind.get(key).push(event);
  }
  for (const claudeEvent of claudeEvents) {
    const key = eventKind(claudeEvent);
    const candidates = openpByKind.get(key);
    const openpEvent = candidates?.shift();
    if (!openpEvent) {
      gaps.push({ kind: key, missingEvent: true });
      continue;
    }
    const missingKeys = Object.keys(claudeEvent).filter((field) => !Object.prototype.hasOwnProperty.call(openpEvent, field));
    if (missingKeys.length > 0) {
      gaps.push({ kind: key, missingTopLevelKeys: missingKeys.sort() });
    }
    const claudeMessage = claudeEvent.message;
    const openpMessage = openpEvent.message;
    if (claudeMessage && openpMessage && typeof claudeMessage === 'object' && typeof openpMessage === 'object') {
      const missingMessageKeys = Object.keys(claudeMessage).filter((field) => !Object.prototype.hasOwnProperty.call(openpMessage, field));
      if (missingMessageKeys.length > 0) {
        gaps.push({ kind: `${key}.message`, missingKeys: missingMessageKeys.sort() });
      }
      const claudeContent = Array.isArray(claudeMessage.content) ? claudeMessage.content : null;
      const openpContent = Array.isArray(openpMessage.content) ? openpMessage.content : null;
      if (claudeContent && openpContent) {
        const claudeTypes = contentBlockTypes(claudeContent);
        const openpTypes = contentBlockTypes(openpContent);
        if (JSON.stringify(claudeTypes) !== JSON.stringify(openpTypes)) {
          gaps.push({ kind: `${key}.message.content`, contentBlockTypes: { claude: claudeTypes, openp: openpTypes } });
        }
        if (hasStructuredOutputToolUse(claudeContent) && !hasStructuredOutputToolUse(openpContent)) {
          gaps.push({ kind: `${key}.message.content`, missingStructuredOutputToolUse: true });
        }
      }
    }
  }
  for (const [key, candidates] of openpByKind.entries()) {
    if (candidates.length > 0) {
      gaps.push({ kind: key, extraEventCount: candidates.length });
    }
  }
  return gaps;
}

function eventKind(event) {
  if (event.type === 'stream_event') {
    return `stream_event:${event.event?.type ?? 'unknown'}`;
  }
  return event.subtype ? `${event.type}:${event.subtype}` : event.type;
}

function toCompatibilityValue(value) {
  if (Array.isArray(value)) {
    return value.map((event) => toCompatibilityEvent(event));
  }
  return toCompatibilityEvent(value);
}

function openPOutput(openp) {
  return openp.output && typeof openp.output === 'object' && !Array.isArray(openp.output)
    ? openp.output
    : {};
}

function openPMetadata(openp) {
  return openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata
    : {};
}

function openPResultText(openp) {
  const output = openPOutput(openp);
  const answers = Array.isArray(output.answer) ? output.answer : [];
  return answers.filter((item) => typeof item === 'string').join('\n\n');
}

function toCompatibilityEvent(event) {
  if (!isOpenPNativeRecord(event)) {
    return event;
  }
  const openp = event.openp;
  const metadata = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata
    : {};
  if (openp.form === 'result') {
    return compactObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: openp.sessionId ?? undefined,
      result: openPResultText(openp),
      structured_output: Object.prototype.hasOwnProperty.call(openp, 'structuredOutput')
        ? openp.structuredOutput
        : undefined,
    });
  }
  if (openp.form === 'streaming') {
    return compactObject({
      type: 'assistant',
      session_id: openp.sessionId ?? undefined,
      message: {
        type: 'message',
        role: 'assistant',
        id: metadata.messageId ?? undefined,
        content: openPMessageContent(openp),
        stop_reason: metadata.stopReason ?? null,
      },
    });
  }
  return {
    type: 'openp',
    subtype: openp.form,
  };
}

function openPMessageContent(openp) {
  if (Array.isArray(openp.messageBlocks)) {
    return openp.messageBlocks;
  }
  const output = openPOutput(openp);
  if (typeof output.reasoning === 'string') {
    return output.reasoning ? [{ type: 'thinking', thinking: output.reasoning }] : [];
  }
  if (typeof output.answer === 'string') {
    return output.answer ? [{ type: 'text', text: output.answer }] : [];
  }
  if (output.toolCall && typeof output.toolCall === 'object' && !Array.isArray(output.toolCall)) {
    return [output.toolCall];
  }
  if (output.toolResult && typeof output.toolResult === 'object' && !Array.isArray(output.toolResult)) {
    return [output.toolResult];
  }
  return [];
}

function isOpenPNativeRecord(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    value.openp &&
    typeof value.openp === 'object' &&
    !Array.isArray(value.openp),
  );
}

function assertOpenPNativeRecord(value, label) {
  if (!isOpenPNativeRecord(value)) {
    throw new Error(`${label}: expected openp-native record`);
  }
}

function assertOpenPNativeRecords(events, label) {
  for (const [index, event] of events.entries()) {
    assertOpenPNativeRecord(event, `${label}[${index}]`);
  }
}

function findOpenPTurnResult(openpEvents, label) {
  const resultIndexes = openpEvents
    .map((openp, index) => openp.form === 'result' ? index : -1)
    .filter((index) => index >= 0);
  if (resultIndexes.length !== 1) {
    throw new Error(`${label}: expected exactly one root openp result record, found ${resultIndexes.length}`);
  }
  const resultIndex = resultIndexes[0];
  if (resultIndex !== openpEvents.length - 1) {
    throw new Error(`${label}: root openp result record must be the final stream record`);
  }
  const result = openpEvents[resultIndex];
  assertObject(result, `${label} openp result`);
  return result;
}

function assertOpenPStreamingTextSnapshots(openpEvents, key, label, options) {
  const snapshots = openpEvents
    .filter((openp) => openp.form === 'streaming' && openp.scope === 'active')
    .map((openp) => {
      const output = openPOutput(openp);
      return typeof output[key] === 'string' ? output[key] : '';
    })
    .filter((text) => text.length > 0);
  if (!options.required && snapshots.length < 2) {
    return;
  }
  if (snapshots.length < 2) {
    throw new Error(`${label}: expected at least two streaming ${key} snapshots to verify cumulative output`);
  }
  const report = incrementalTextReport(snapshots);
  if (!report.allTextEventsPrefixCompatible) {
    throw new Error(`${label}: streaming ${key} snapshots are not cumulative`);
  }
}

function assertNoActiveOpenPStreamingRecords(openpEvents, label) {
  for (const [index, openp] of openpEvents.entries()) {
    if (openp.form !== 'streaming') {
      continue;
    }
    if (openp.scope === 'active') {
      throw new Error(`${label}: unexpected active streaming record`);
    }
    const output = openPOutput(openp);
    const keys = Object.keys(output);
    if (openp.scope !== 'background' || keys.length !== 1 || keys[0] !== 'answer' || typeof output.answer !== 'string') {
      throw new Error(`${label}[${index}]: result-only mode permits only background streaming answer records`);
    }
  }
}

function collectOpenPEventPayloads(value) {
  const events = [];
  const seen = new Set();
  walk(value, (item, path) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }
    if (item.openp && typeof item.openp === 'object' && !Array.isArray(item.openp)) {
      if (!seen.has(item.openp)) {
        seen.add(item.openp);
        events.push(item.openp);
      }
    }
  });
  return events;
}

function assertOpenPContractShape(openpEvents, label) {
  const allowedForms = new Set(['streaming', 'result']);
  const allowedScopes = new Set(['active', 'background']);
  const allowedOutputKeys = ['answer', 'reasoning', 'toolCall', 'toolResult'];
  for (const [index, openp] of openpEvents.entries()) {
    if (!allowedForms.has(openp.form)) {
      throw new Error(`${label}[${index}]: unsupported openp.form ${JSON.stringify(openp.form)}`);
    }
    if (!allowedScopes.has(openp.scope)) {
      throw new Error(`${label}[${index}]: unsupported openp.scope ${JSON.stringify(openp.scope)}`);
    }
    assertMessageBlocksHaveAllowedTypes(openPMetadata(openp).messageBlocks, null, `${label}[${index}]`);
    const output = openPOutput(openp);
    const keys = Object.keys(output);
    if (openp.form === 'streaming') {
      const present = keys.filter((key) => allowedOutputKeys.includes(key));
      if (present.length !== 1 || present.length !== keys.length) {
        throw new Error(`${label}[${index}]: streaming openp.output must contain exactly one payload key`);
      }
      const key = present[0];
      if ((key === 'answer' || key === 'reasoning') && typeof output[key] !== 'string') {
        throw new Error(`${label}[${index}]: streaming ${key} must be a string snapshot`);
      }
      if ((key === 'toolCall' || key === 'toolResult') && (!output[key] || typeof output[key] !== 'object' || Array.isArray(output[key]))) {
        throw new Error(`${label}[${index}]: streaming ${key} must be an object`);
      }
      continue;
    }
    if (keys.length !== allowedOutputKeys.length || keys.some((key) => !allowedOutputKeys.includes(key))) {
      throw new Error(`${label}[${index}]: result openp.output must contain exactly answer/reasoning/toolCall/toolResult`);
    }
    for (const key of allowedOutputKeys) {
      if (!Array.isArray(output[key])) {
        throw new Error(`${label}[${index}]: result openp.output.${key} must be an array`);
      }
    }
  }
}

function assertMessageBlocksHaveAllowedTypes(value, allowedTypes, label) {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} messageBlocks must be an array when present`);
  }
  for (const [index, block] of value.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`${label} messageBlocks[${index}] must be an object`);
    }
    const type = block.type;
    if (typeof type !== 'string') {
      throw new Error(`${label} messageBlocks[${index}] must have a string type`);
    }
    if (allowedTypes && !allowedTypes.has(type)) {
      throw new Error(`${label} messageBlocks[${index}] has disallowed type ${JSON.stringify(type)}`);
    }
    if (!allowedTypes && !isNeutralMetadataBlock(block)) {
      throw new Error(`${label} messageBlocks[${index}] has non-metadata payload ${JSON.stringify(block)}`);
    }
  }
}

function isNeutralMetadataBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return false;
  }
  const type = block.type;
  if (typeof type !== 'string') {
    return false;
  }
  if (isForbiddenOpenPMetadataTypeValue(type)) {
    return false;
  }
  return !hasOpenPMetadataForbiddenField(block);
}

function isForbiddenOpenPMetadataTypeValue(value) {
  return new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'tool_use',
    'server_tool_use',
    'tool_result',
    'output_text',
    'message.partial',
    'message.final',
  ]).has(value);
}

function hasOpenPMetadataForbiddenField(value) {
  const forbiddenFields = new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'input',
    'content',
    'tool_use_id',
    'is_error',
  ]);
  const visit = (item, nestedDepth) => {
    if (Array.isArray(item)) {
      return item.some((nested) => visit(nested, nestedDepth + 1));
    }
    if (!item || typeof item !== 'object') {
      return false;
    }
    for (const [key, nested] of Object.entries(item)) {
      if (forbiddenFields.has(key)) {
        return true;
      }
      if (
        key === 'type' &&
        typeof nested === 'string' &&
        isForbiddenOpenPMetadataTypeValue(nested)
      ) {
        return true;
      }
      if (visit(nested, nestedDepth + 1)) {
        return true;
      }
    }
    return false;
  };
  return visit(value, 0);
}

function assertOpenPStructuredResultArtifact(rootOpenPEvents, allOpenPEvents, label) {
  const result = findOpenPTurnResult(rootOpenPEvents, label);
  const output = openPOutput(result);
  const structuredOutputJson = JSON.stringify(result.structuredOutput);
  const structuredToolCall = findStructuredOutputToolCall(output.toolCall, structuredOutputJson);
  if (!structuredToolCall) {
    throw new Error(`${label}: result missing StructuredOutput toolCall for structuredOutput`);
  }
  const toolUseId = structuredToolCall.id;
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
    throw new Error(`${label}: StructuredOutput toolCall missing id`);
  }
  if (!hasStructuredOutputToolResult(output.toolResult, toolUseId)) {
    throw new Error(`${label}: result missing StructuredOutput toolResult for ${toolUseId}`);
  }
  const hasStructuredAssistant = allOpenPEvents.some((openp) => (
    openp.form === 'result' &&
    JSON.stringify(openp.structuredOutput) === structuredOutputJson &&
    Boolean(findStructuredOutputToolCall(openPOutput(openp).toolCall, structuredOutputJson))
  ));
  const hasStructuredToolResult = allOpenPEvents.some((openp) => (
    openp.form === 'result' &&
    hasStructuredOutputToolResult(openPOutput(openp).toolResult, toolUseId)
  ));
  if (!hasStructuredAssistant && !hasStructuredToolResult) {
    throw new Error(`${label}: missing linked structured output assistant/tool artifact`);
  }
}

function findStructuredOutputToolCall(value, structuredOutputJson) {
  const toolCalls = Array.isArray(value) ? value : [];
  return toolCalls.find((toolCall) => (
    toolCall &&
    typeof toolCall === 'object' &&
    !Array.isArray(toolCall) &&
    toolCall.type === 'tool_use' &&
    toolCall.name === 'StructuredOutput' &&
    JSON.stringify(toolCall.input) === structuredOutputJson
  )) ?? null;
}

function hasStructuredOutputToolResult(value, toolUseId) {
  const toolResults = Array.isArray(value) ? value : [];
  return toolResults.some((toolResult) => (
    toolResult &&
    typeof toolResult === 'object' &&
    !Array.isArray(toolResult) &&
    toolResult.type === 'tool_result' &&
    toolResult.toolUseId === toolUseId
  ));
}

function findResult(events) {
  const compatibilityEvents = toCompatibilityValue(events);
  assertArray(compatibilityEvents, 'stream-json events');
  const result = compatibilityEvents.find((event) => event.type === 'result');
  assertObject(result, 'result event');
  return result;
}

function resultObject(value) {
  const compatibilityValue = toCompatibilityValue(value);
  if (Array.isArray(compatibilityValue)) {
    return findResult(compatibilityValue);
  }
  assertObject(compatibilityValue, 'result object');
  return compatibilityValue;
}

function contentBlockTypes(content) {
  return content.map((block) => block && typeof block === 'object' ? block.type ?? 'unknown' : 'unknown');
}

function hasStructuredOutputToolUse(content) {
  return content.some((block) => block && typeof block === 'object' && block.type === 'tool_use' && block.name === 'StructuredOutput');
}

function assertHasEvent(events, type, label) {
  if (!events.some((event) => event.type === type)) {
    throw new Error(`${label}: missing ${type}`);
  }
}

function assertAssistantBeforeResult(events, label) {
  const resultIndex = events.findIndex((event) => event.type === 'result');
  if (resultIndex < 0) {
    throw new Error(`${label}: missing result`);
  }
  if (!events.slice(0, resultIndex).some((event) => event.type === 'assistant')) {
    throw new Error(`${label}: missing assistant before result`);
  }
}

function requiredResultOrientedEventTypes(value) {
  assertArray(value, 'stream-json events');
  return value
    .filter((event) => event.type !== 'rate_limit_event')
    .map((event) => event.type);
}

function requiredResultOrientedMilestones(value) {
  assertArray(value, 'stream-json events');
  const events = value.filter((event) => event.type !== 'rate_limit_event');
  const milestones = [];
  if (events.some((event) => event.type === 'system')) {
    milestones.push('system');
  }
  if (nonEmptyBlockTexts(assistantEventsBeforeResult(events), 'text', 'text').length > 0) {
    milestones.push('assistant:text');
  }
  if (events.some((event) => event.type === 'result')) {
    milestones.push('result');
  }
  return milestones;
}

function assertHasStreamEvent(events, type, label) {
  if (!events.some((event) => event.type === 'stream_event' && event.event?.type === type)) {
    throw new Error(`${label}: missing stream_event ${type}`);
  }
}

function assertHasTextDelta(events, label) {
  if (!events.some((event) => event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event?.delta?.type === 'text_delta')) {
    throw new Error(`${label}: missing text_delta`);
  }
}

function compactObject(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function parseJsonObject(text) {
  return JSON.parse(text.trim());
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function runCommand(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutRemainder = '';
    const lineArrivals = [];
    let stdoutChunkSeq = 0;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutChunkSeq += 1;
      stdout += chunk;
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const event = JSON.parse(line);
          const compatibilityEvent = toCompatibilityEvent(event);
          lineArrivals.push({
            ms: Date.now() - started,
            chunkSeq: stdoutChunkSeq,
            type: compatibilityEvent.type ?? null,
            contentTypes: Array.isArray(compatibilityEvent.message?.content)
              ? compatibilityEvent.message.content.map((block) => block?.type ?? null)
              : null,
            openpForm: event.openp?.form ?? null,
            openpScope: event.openp?.scope ?? null,
          });
        } catch {
          lineArrivals.push({
            ms: Date.now() - started,
            chunkSeq: stdoutChunkSeq,
            type: null,
          });
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, lineArrivals });
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    child.stdin.end(input);
  });
}

function assertNoOpenPOnlyFieldsDeep(value, label) {
  const fields = collectOpenPOnlyFields(value);
  if (fields.length > 0) {
    throw new Error(`${label}: open-p-only public fields found: ${fields.join(', ')}`);
  }
}

function assertNoOpenPOnlyFields(value, label) {
  assertNoOpenPOnlyFieldsDeep(value, label);
}

function collectOpenPOnlyFields(value) {
  const fields = [];
  walk(value, (item, path) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }
    for (const field of Object.keys(item)) {
      const fullPath = path ? `${path}.${field}` : field;
      if (field === 'openp') {
        fields.push(fullPath);
      }
      if (path === '' && (field === 'turnId' || field === 'sessionId' || field === 'text' || field === 'diagnostics')) {
        fields.push(fullPath);
      }
      if (fullPath === 'modelUsage.openp') {
        fields.push(fullPath);
      }
    }
  });
  return fields.sort();
}

function assertNoLegacyTopLevelFields(value, label) {
  const fields = collectLegacyTopLevelFields(value);
  if (fields.length > 0) {
    throw new Error(`${label}: legacy top-level fields found: ${fields.join(', ')}`);
  }
}

function assertNoLegacyTopLevelFieldsDeep(value, label) {
  assertNoLegacyTopLevelFields(value, label);
}

function collectLegacyTopLevelFields(value) {
  const fields = [];
  walk(value, (item, path) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }
    if (!item.openp || typeof item.openp !== 'object' || Array.isArray(item.openp)) {
      return;
    }
    for (const field of Object.keys(item)) {
      if (field !== 'openp') {
        fields.push(path ? `${path}.${field}` : field);
      }
    }
  });
  return fields.sort();
}

function assertNoForbiddenOpenPFields(value, label) {
  const fields = collectForbiddenOpenPFields(value);
  if (fields.length > 0) {
    throw new Error(`${label}: forbidden openp fields found: ${fields.join(', ')}`);
  }
}

function collectForbiddenOpenPFields(value) {
  const fields = [];
  const forbiddenOpenPTopLevel = new Set([
    'type',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
  ]);
  walk(value, (item, path) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }
    const isOpenPPayload = Object.prototype.hasOwnProperty.call(item, 'form') &&
      Object.prototype.hasOwnProperty.call(item, 'output') &&
      Object.prototype.hasOwnProperty.call(item, 'version');
    for (const field of Object.keys(item)) {
      const fullPath = path ? `${path}.${field}` : field;
      if (field === 'legacyTopLevel' || field === 'textDelta' || field === 'assistant.message' || field === 'assistant.event') {
        fields.push(fullPath);
      }
      if (isOpenPPayload && forbiddenOpenPTopLevel.has(field)) {
        fields.push(fullPath);
      }
      if (field === 'type' && (item[field] === 'message.partial' || item[field] === 'message.final')) {
        fields.push(fullPath);
      }
    }
  });
  return fields.sort();
}

function walk(value, visitor, path = '') {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walk(child, visitor, path ? `${path}.${key}` : key);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected array`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertResultEndsWithMarker(actual, expected, label) {
  if (typeof actual !== 'string' || !actual.trimEnd().endsWith(expected)) {
    throw new Error(`${label}: expected result to end with ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function readArg(name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}
