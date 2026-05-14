#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  incrementalTextReport,
  previewFinalCompatibilityReport,
} from './claude-p-contract-helpers.mjs';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(rootDir, 'dist', 'src', 'cli.js');
const enabled = process.env.OPENP_LIVE_CLAUDE_P_CONTRACT === '1';
const strict = process.env.OPENP_LIVE_CLAUDE_P_STRICT === '1';
const timeoutMs = Number.parseInt(process.env.OPENP_LIVE_CLAUDE_P_TIMEOUT_MS ?? '120000', 10);
const claudeBin = process.env.OPENP_CONTRACT_CLAUDE_BIN ?? 'claude';
const model = process.env.OPENP_CONTRACT_MODEL ?? 'sonnet';
const effort = process.env.OPENP_CONTRACT_EFFORT ?? 'low';

if (!enabled) {
  console.log('Skipping live Claude -p contract verification. Set OPENP_LIVE_CLAUDE_P_CONTRACT=1 after running npm run build.');
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
const permissionArgs = ['--permission-mode', 'bypassPermissions'];
const reasoningArgs = effort ? ['--effort', effort] : [];

const cases = [
  {
    name: 'json',
    expected: `openp-contract-json-${randomUUID().slice(0, 8)}`,
    claudeArgs: (prompt) => ['-p', '--output-format', 'json', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['--output-format', 'json', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonObject,
    verify: verifyJsonResult,
  },
  {
    name: 'stream-json',
    expected: `openp-contract-stream-${randomUUID().slice(0, 8)}`,
    claudeArgs: (prompt) => ['-p', '--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonLines,
    verify: verifyStreamJsonResult,
  },
  {
    name: 'stream-json-partial',
    expected: `openp-contract-partial-${randomUUID().slice(0, 8)}`,
    claudeArgs: (prompt) => ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonLines,
    verify: verifyPartialStreamJsonResult,
  },
  {
    name: 'stream-json-structured-partial',
    expected: '{"ok":true}',
    claudeArgs: (prompt) => ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', schema, ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    openpArgs: (prompt) => ['--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', schema, ...permissionArgs, '--model', model, ...reasoningArgs, prompt],
    parse: parseJsonLines,
    verify: verifyStructuredStreamJsonResult,
  },
  {
    name: 'worker-stream-json',
    expected: `openp-contract-worker-${randomUUID().slice(0, 8)}`,
    claudeArgs: () => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs],
    openpArgs: () => ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...permissionArgs, '--model', model, ...reasoningArgs],
    input: (expected) => JSON.stringify({ type: 'user', message: { role: 'user', content: promptForContract(expected) } }) + '\n',
    parse: parseJsonLines,
    verify: verifyStreamJsonResult,
  },
  {
    name: 'worker-stream-json-partial',
    expected: `openp-contract-worker-partial-${randomUUID().slice(0, 8)}`,
    claudeArgs: () => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs],
    openpArgs: () => ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs, '--model', model, ...reasoningArgs],
    input: (expected) => JSON.stringify({ type: 'user', message: { role: 'user', content: promptForContract(expected) } }) + '\n',
    parse: parseJsonLines,
    verify: verifyPartialStreamJsonResult,
  },
];
const caseFilter = (process.env.OPENP_LIVE_CLAUDE_P_CASES ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const selectedCases = caseFilter.length > 0
  ? cases.filter((testCase) => caseFilter.includes(testCase.name))
  : cases;

if (caseFilter.length > 0 && selectedCases.length !== caseFilter.length) {
  const selectedNames = new Set(selectedCases.map((testCase) => testCase.name));
  const unknown = caseFilter.filter((name) => !selectedNames.has(name));
  throw new Error(`unknown live Claude -p contract case(s): ${unknown.join(', ')}`);
}

const report = [];
const requiredFailures = [];

for (const testCase of selectedCases) {
  const prompt = testCase.name === 'stream-json-structured-partial'
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
    claudeTiming: nonPartialTiming(claudeRaw.lineArrivals),
    openpTiming: nonPartialTiming(openpRaw.lineArrivals),
    requiredContractFailures,
    strictGaps,
  });
}

const gapCount = report.reduce((sum, item) => sum + item.strictGaps.length, 0);
const requiredContractOk = requiredFailures.length === 0;
console.log(JSON.stringify({
  ok: gapCount === 0,
  requiredContractOk,
  strict,
  model,
  effort,
  strictGapCount: gapCount,
  report,
}, null, 2));

if (requiredFailures.length > 0) {
  throw new Error(`required Claude -p contract comparison found ${requiredFailures.length} failure(s)`);
}

if (strict && gapCount > 0) {
  throw new Error(`strict Claude -p shape comparison found ${gapCount} gap(s)`);
}

function promptForContract(expected) {
  return [
    'Analyze the architecture tradeoffs for a multi-backend interactive agent CLI compatibility layer.',
    'Compare PTY-based interactive runners, stdout JSON event protocols, persistent app-server protocols, session resume semantics, structured output validation, and streaming event contracts.',
    'Give a detailed but concise engineering analysis with at least 8 numbered points and a final recommendation.',
    `End the final visible answer with this exact marker: ${expected}`,
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
  assertObject(result, `${label} ${testCase.name}`);
  assertEqual(result.type, 'result', `${label} ${testCase.name} type`);
  assertEqual(result.subtype, 'success', `${label} ${testCase.name} subtype`);
  assertEqual(result.is_error, false, `${label} ${testCase.name} is_error`);
  assertResultEndsWithMarker(result.result, testCase.expected, `${label} ${testCase.name} result`);
  assertNoOpenPOnlyFields(result, `${label} ${testCase.name} result`);
}

function verifyStreamJsonResult(testCase, events, label) {
  assertArray(events, `${label} ${testCase.name}`);
  const result = findResult(events);
  assertResultEndsWithMarker(result.result, testCase.expected, `${label} ${testCase.name} result`);
  assertHasEvent(events, 'system', `${label} ${testCase.name} system`);
  assertHasEvent(events, 'assistant', `${label} ${testCase.name} assistant`);
  assertAssistantBeforeResult(events, `${label} ${testCase.name}`);
  assertNoOpenPOnlyFieldsDeep(events, `${label} ${testCase.name}`);
}

function verifyPartialStreamJsonResult(testCase, events, label) {
  verifyStreamJsonResult(testCase, events, label);
  assertHasStreamEvent(events, 'message_start', `${label} ${testCase.name} message_start`);
  assertHasStreamEvent(events, 'content_block_start', `${label} ${testCase.name} content_block_start`);
  assertHasTextDelta(events, `${label} ${testCase.name} text_delta`);
  assertHasStreamEvent(events, 'content_block_stop', `${label} ${testCase.name} content_block_stop`);
  assertHasStreamEvent(events, 'message_delta', `${label} ${testCase.name} message_delta`);
  assertHasStreamEvent(events, 'message_stop', `${label} ${testCase.name} message_stop`);
}

function verifyStructuredStreamJsonResult(testCase, events, label) {
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

function verifyCrossContract(testCase, claudeValue, openpValue) {
  const claudeResult = resultObject(claudeValue);
  const openpResult = resultObject(openpValue);
  assertResultEndsWithMarker(claudeResult.result, testCase.expected, `${testCase.name} claude marker`);
  assertResultEndsWithMarker(openpResult.result, testCase.expected, `${testCase.name} openp marker`);
  const claudeStructured = Object.prototype.hasOwnProperty.call(claudeResult, 'structured_output')
    ? claudeResult.structured_output
    : null;
  const openpStructured = Object.prototype.hasOwnProperty.call(openpResult, 'structured_output')
    ? openpResult.structured_output
    : null;
  assertEqual(JSON.stringify(openpStructured), JSON.stringify(claudeStructured), `${testCase.name} cross structured_output`);
}

function collectRequiredContractFailures(testCase, values) {
  if (testCase.name !== 'stream-json' && testCase.name !== 'worker-stream-json') {
    return [];
  }
  const failures = [];
  const claudeAssistant = assistantEventsBeforeResult(values.claudeParsed);
  const openpAssistant = assistantEventsBeforeResult(values.openpParsed);
  const claudeText = nonEmptyBlockTexts(claudeAssistant, 'text', 'text');
  const openpText = nonEmptyBlockTexts(openpAssistant, 'text', 'text');
  if (claudeText.length > 0 && openpText.length === 0) {
    failures.push({
      kind: 'assistant.text',
      reason: 'raw claude emitted text before result, openp did not',
      claudeSample: claudeText[0],
    });
  }
  const claudeIncrementalText = incrementalTextReport(claudeText);
  const openpIncrementalText = incrementalTextReport(openpText);
  if (openpText.length >= 2 && !openpIncrementalText.allTextEventsPrefixCompatible) {
    failures.push({
      kind: 'assistant.text.incremental.openp',
      reason: 'openp emitted multiple assistant text previews before result, but they were not a monotonic growing prefix sequence',
      claude: claudeIncrementalText,
      openp: openpIncrementalText,
    });
  }
  const openpPreviewFinalCompatibility = previewFinalCompatibilityReport(openpText, resultObject(values.openpParsed).result);
  if (!openpPreviewFinalCompatibility.compatible) {
    failures.push({
      kind: 'assistant.text.preview-final.openp',
      reason: 'openp assistant previews were not recognizably derived from the final result text',
      openp: openpPreviewFinalCompatibility,
    });
  }
  const claudeRequiredEventTypes = requiredNonPartialEventTypes(values.claudeParsed);
  const openpRequiredEventTypes = requiredNonPartialEventTypes(values.openpParsed);
  const claudeRequiredMilestones = requiredNonPartialMilestones(values.claudeParsed);
  const openpRequiredMilestones = requiredNonPartialMilestones(values.openpParsed);
  if (JSON.stringify(openpRequiredMilestones) !== JSON.stringify(claudeRequiredMilestones)) {
    failures.push({
      kind: 'event.milestones',
      reason: 'openp non-partial public event milestones differ from raw claude after excluding rate_limit_event and cumulative text previews',
      claude: claudeRequiredMilestones,
      openp: openpRequiredMilestones,
      claudeRawEventTypes: claudeRequiredEventTypes,
      openpRawEventTypes: openpRequiredEventTypes,
    });
  }
  return failures;
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

function nonPartialTiming(lineArrivals) {
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
    const result = findResult(value);
    const assistantTextBeforeResult = nonEmptyBlockTexts(
      assistantEventsBeforeResult(value),
      'text',
      'text',
    );
    return {
      eventTypes: value.map((event) => event.type),
      streamEventTypes: value.filter((event) => event.type === 'stream_event').map((event) => event.event?.type),
      assistantContentBeforeResult: assistantEventsBeforeResult(value).map((event) => {
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
      assistantTextPreviewFinalCompatibility: previewFinalCompatibilityReport(
        assistantTextBeforeResult,
        result.result,
      ),
      result: result.result,
      structuredOutput: result.structured_output ?? null,
      forbiddenFields: collectOpenPOnlyFields(value),
    };
  }
  return {
    type: value.type,
    subtype: value.subtype,
    result: value.result,
    structuredOutput: value.structured_output ?? null,
    forbiddenFields: collectOpenPOnlyFields(value),
  };
}

function collectStrictShapeGaps(claudeValue, openpValue) {
  const gaps = [];
  const claudeEvents = Array.isArray(claudeValue) ? claudeValue : [claudeValue];
  const openpEvents = Array.isArray(openpValue) ? openpValue : [openpValue];
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

function findResult(events) {
  const result = events.find((event) => event.type === 'result');
  assertObject(result, 'result event');
  return result;
}

function resultObject(value) {
  if (Array.isArray(value)) {
    return findResult(value);
  }
  assertObject(value, 'result object');
  return value;
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

function requiredNonPartialEventTypes(value) {
  assertArray(value, 'stream-json events');
  return value
    .filter((event) => event.type !== 'rate_limit_event')
    .map((event) => event.type);
}

function requiredNonPartialMilestones(value) {
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
          lineArrivals.push({
            ms: Date.now() - started,
            chunkSeq: stdoutChunkSeq,
            type: event.type ?? null,
            contentTypes: Array.isArray(event.message?.content)
              ? event.message.content.map((block) => block?.type ?? null)
              : null,
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
