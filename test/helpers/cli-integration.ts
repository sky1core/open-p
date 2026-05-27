import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const CODEX_SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const KIRO_SESSION_ID = '33333333-3333-4333-8333-333333333333';
export const DIRECT_CLI_TEST_SESSION_ID = '44444444-4444-4444-8444-444444444444';

export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  input = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, [...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.end(input);
  return collectChild(child);
}

export async function withFakeCommandEnv(
  commandName: string,
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const binDir = await mkdtemp(join(tmpdir(), `openp-${commandName}-bin-`));
  await symlink(target, join(binDir, commandName));
  const isolatedEnv = { ...env };
  if (commandName === 'codex' && isolatedEnv.CODEX_HOME === undefined) {
    isolatedEnv.CODEX_HOME = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  }
  return {
    ...isolatedEnv,
    PATH: `${binDir}:${isolatedEnv.PATH ?? process.env.PATH ?? ''}`,
  };
}

export async function writeCodexCliSessionLog(codexHome: string, sessionId: string): Promise<void> {
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '23');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `rollout-${sessionId}.jsonl`), [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-cli-test' } }),
    '',
  ].join('\n'));
}

export function collectChild(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!child.stdout || !child.stderr) {
      reject(new Error('child process stdio is not piped'));
      return;
    }
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function readDebugEntries(path: string): Promise<Array<Record<string, any>>> {
  return (await readFile(path, 'utf8'))
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseOutputLine(line: string): Record<string, any> {
  const event = JSON.parse(line) as Record<string, any>;
  const openp = event.openp;
  assert.deepEqual(Object.keys(event), ['openp']);
  assert.ok(openp && typeof openp === 'object' && !Array.isArray(openp));
  assertNoStreamingAssistantTextAliases(openp);
  return event;
}

function assertNoStreamingAssistantTextAliases(openp: Record<string, any>): void {
  const output = openp.output && typeof openp.output === 'object' && !Array.isArray(openp.output)
    ? openp.output as Record<string, unknown>
    : {};
  assert.ok(openp.form === 'streaming' || openp.form === 'result');
  assert.ok(openp.scope === 'active' || openp.scope === 'background');
  for (const field of ['type', 'kind', 'text', 'textDelta', 'answerText', 'answers', 'reasoningText', 'reasoning', 'toolCalls', 'toolResults', 'assistant.message', 'assistant.event']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(openp, field),
      false,
      `openp must not expose legacy field ${field}`,
    );
  }
  if (openp.form === 'streaming') {
    assert.equal(Object.keys(output).length, 1);
    assert.ok(['answer', 'reasoning', 'toolCall', 'toolResult'].includes(Object.keys(output)[0]!));
  } else {
    assert.deepEqual(Object.keys(output).sort(), ['answer', 'reasoning', 'toolCall', 'toolResult'].sort());
    assert.ok(Array.isArray(output.answer));
    assert.ok(Array.isArray(output.reasoning));
    assert.ok(Array.isArray(output.toolCall));
    assert.ok(Array.isArray(output.toolResult));
  }
  const metadata = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata as Record<string, unknown>
    : {};
  if (Array.isArray(metadata.messageBlocks)) {
    for (const block of metadata.messageBlocks) {
      assertNeutralOpenPMetadataBlock(block);
    }
  }
}

function assertNeutralOpenPMetadataBlock(block: unknown): void {
  assert.ok(block && typeof block === 'object' && !Array.isArray(block));
  const item = block as Record<string, unknown>;
  assert.equal(typeof item.type, 'string');
  assert.equal([
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
  ].includes(String(item.type)), false);
  assert.equal(hasOpenPMetadataForbiddenField(item), false);
}

function isForbiddenOpenPMetadataTypeValue(value: string): boolean {
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

function hasOpenPMetadataForbiddenField(value: unknown): boolean {
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
  const visit = (item: unknown, nestedDepth: number): boolean => {
    if (Array.isArray(item)) {
      return item.some((nested) => visit(nested, nestedDepth + 1));
    }
    if (!item || typeof item !== 'object') {
      return false;
    }
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
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

export function streamingAnswerTexts(events: readonly Record<string, any>[]): string[] {
  return streamingTextsByKind(events, 'answer');
}

export function streamingReasoningTexts(events: readonly Record<string, any>[]): string[] {
  return streamingTextsByKind(events, 'reasoning');
}

function streamingTextsByKind(events: readonly Record<string, any>[], kind: string): string[] {
  return events
    .map((event) => event.openp)
    .map((openp) => {
      const output = openp?.output && typeof openp.output === 'object' && !Array.isArray(openp.output)
        ? openp.output as Record<string, unknown>
        : {};
      return openp?.form === 'streaming' && typeof output[kind] === 'string'
        ? output[kind] as string
        : null;
    })
    .filter((text): text is string => typeof text === 'string');
}

export function assertNoTopLevelResultFormEvents(events: readonly Record<string, any>[]): void {
  assert.equal(
    events.slice(0, -1).some((event) => event.openp?.form === 'result'),
    false,
  );
}

export function assertNativeOpenPOnlyStdout(stdout: string): void {
  assert.equal(stdout.includes('legacyTopLevel'), false);
  assert.equal(stdout.includes('textDelta'), false);
  for (const line of stdout.trimEnd().split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    assert.deepEqual(Object.keys(event), ['openp']);
  }
}

export function terminalOpenPResult(events: readonly Record<string, any>[]): Record<string, any> {
  const terminal = events.find((event) => event.openp?.form === 'result')?.openp;
  assert.ok(terminal, 'expected terminal result');
  return terminal;
}

export function terminalResultAnswer(events: readonly Record<string, any>[]): string {
  return resultAnswerText(terminalOpenPResult(events));
}

export function resultAnswerText(openp: Record<string, any>): string {
  return resultTextArray(openp, 'answer').join('\n\n');
}

export function resultReasoningTexts(openp: Record<string, any>): string[] {
  return resultTextArray(openp, 'reasoning');
}

export function resultAnswerTexts(openp: Record<string, any>): string[] {
  return resultTextArray(openp, 'answer');
}

export function resultWarnings(openp: Record<string, any>): unknown {
  const metadata = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata as Record<string, unknown>
    : {};
  return metadata.warnings;
}

export function streamingOutputKeys(events: readonly Record<string, any>[]): string[] {
  return events
    .map((event) => event.openp)
    .filter((openp) => openp?.form === 'streaming')
    .map((openp) => Object.keys(openp.output ?? {})[0])
    .filter((key): key is string => typeof key === 'string');
}

function resultTextArray(openp: Record<string, any>, key: 'answer' | 'reasoning'): string[] {
  const output = openp.output && typeof openp.output === 'object' && !Array.isArray(openp.output)
    ? openp.output as Record<string, unknown>
    : {};
  return ((Array.isArray(output[key]) ? output[key] : []) as unknown[])
    .filter((text): text is string => typeof text === 'string');
}

export async function waitForOutput(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for output');
}

export async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
