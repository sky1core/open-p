import { randomUUID } from 'node:crypto';
import { stdin } from 'node:process';
import { EXIT_CODES, OpenPError } from './errors.js';
import { parseJsonSchemaText } from './json-schema.js';
import type { OutputFormat } from './output.js';
import { isSafeSessionId } from './session-id.js';

export type InputFormat = 'text' | 'stream-json';

export type DebugLogOption =
  | { readonly kind: 'off' }
  | { readonly kind: 'default' };

export interface CliOptions {
  readonly backend: string;
  readonly backendSessionId: string;
  readonly resume: boolean;
  readonly timeoutMs: number;
  readonly inputFormat: InputFormat;
  readonly outputFormat: OutputFormat;
  readonly debugLog: DebugLogOption;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: string | null;
  readonly tools: string | null;
  readonly jsonSchema: string | null;
  readonly streaming: boolean;
  readonly verbose: boolean;
  readonly backendArgs: readonly string[];
  readonly promptArg: string | null;
  readonly turnId: string;
}

export type ResolvedCliOptions = Omit<CliOptions, 'debugLog'> & {
  readonly debugLog: string | null;
};

export interface StreamJsonUserEvent {
  readonly text: string;
  readonly turnId: string | null;
}

const VALUE_FLAGS = new Set([
  '--resume',
  '--timeout',
  '--input-format',
  '--output-format',
  '--model',
  '--effort',
  '--tools',
  '--json-schema',
]);

const BOOLEAN_FLAGS = new Set([
  '--streaming',
  '--dangerously-skip-permissions',
]);

export function parseCliArgs(argv: readonly string[], knownBackends?: ReadonlySet<string>): CliOptions {
  let backend: string | null = null;
  let backendSessionId: string | null = null;
  let resume = false;
  let timeoutMs = 0;
  let inputFormat: InputFormat = 'text';
  let outputFormat: CliOptions['outputFormat'] = 'text';
  let debugLog: DebugLogOption = { kind: 'off' };
  let model: string | null = null;
  let reasoningEffort: string | null = null;
  let permissionMode: string | null = null;
  let tools: string | null = null;
  let jsonSchema: string | null = null;
  let streaming = false;
  let verbose = false;
  const backendArgs: string[] = [];
  const promptParts: string[] = [];

  let subcommandConsumed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') {
      promptParts.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      if (!subcommandConsumed && knownBackends) {
        if (!knownBackends.has(arg)) {
          const available = [...knownBackends].join(', ');
          throw new OpenPError(`unknown backend: ${arg} (available: ${available})`, EXIT_CODES.unsupportedOption);
        }
        backend = arg;
        subcommandConsumed = true;
      } else {
        promptParts.push(arg);
      }
      continue;
    }
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--streaming') {
        streaming = true;
        continue;
      }
      if (arg === '--dangerously-skip-permissions') {
        permissionMode = 'danger-full-access';
        continue;
      }
    }
    if (arg === '--debug-log') {
      debugLog = { kind: 'default' };
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new OpenPError(`unsupported option: ${arg}`, EXIT_CODES.unsupportedOption);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new OpenPError(`missing value for ${arg}`, EXIT_CODES.usage);
    }
    if (value.length === 0 && arg !== '--tools') {
      throw new OpenPError(`missing value for ${arg}`, EXIT_CODES.usage);
    }
    i += 1;
    switch (arg) {
      case '--resume':
        validateSessionId(value, arg);
        backendSessionId = value;
        resume = true;
        break;
      case '--timeout':
        timeoutMs = parseTimeoutMs(value);
        break;
      case '--input-format':
        if (value !== 'text' && value !== 'stream-json') {
          throw new OpenPError(`unsupported input format: ${value}`, EXIT_CODES.unsupportedOption);
        }
        inputFormat = value;
        break;
      case '--output-format':
        if (value !== 'text' && value !== 'json' && value !== 'stream-json') {
          throw new OpenPError(`unsupported output format: ${value}`, EXIT_CODES.unsupportedOption);
        }
        outputFormat = value;
        break;
      case '--model':
        model = value;
        break;
      case '--effort':
        reasoningEffort = value;
        break;
      case '--tools':
        tools = value;
        break;
      case '--json-schema':
        parseJsonSchemaText(value);
        jsonSchema = value;
        break;
    }
  }

  if (streaming && outputFormat !== 'stream-json') {
    throw new OpenPError('--streaming requires --output-format stream-json', EXIT_CODES.usage);
  }

  if (!backend) {
    if (knownBackends) {
      const available = [...knownBackends].join(', ');
      throw new OpenPError(`backend is required: specify as first argument (available: ${available})`, EXIT_CODES.usage);
    }
    backend = 'claude';
  }

  return {
    backend,
    backendSessionId: backendSessionId ?? randomUUID(),
    resume,
    timeoutMs,
    inputFormat,
    outputFormat,
    debugLog,
    model,
    reasoningEffort,
    permissionMode,
    tools,
    jsonSchema,
    streaming,
    verbose,
    backendArgs,
    promptArg: promptParts.length > 0 ? promptParts.join(' ') : null,
    turnId: randomUUID(),
  };
}

export function parseDebugLogOption(argv: readonly string[]): DebugLogOption {
  let debugLog: DebugLogOption = { kind: 'off' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') {
      break;
    }
    if (arg === '--debug-log') {
      debugLog = { kind: 'default' };
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        i += 1;
      }
    }
  }
  return debugLog;
}

export function parseVerboseOption(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === '--') {
      return false;
    }
    if (arg === '--verbose') {
      return true;
    }
  }
  return false;
}

export async function resolvePrompt(promptArg: string | null, inputFormat: InputFormat = 'text'): Promise<string> {
  if (inputFormat === 'text' && promptArg !== null) {
    return promptArg;
  }
  const stdinIsTty = stdin.isTTY === true;
  const stdinText = stdinIsTty ? null : await readStdinText();
  return resolvePromptText({
    promptArg,
    inputFormat,
    stdinText,
    stdinIsTty,
  });
}

export function resolvePromptText(input: {
  readonly promptArg: string | null;
  readonly inputFormat: InputFormat;
  readonly stdinText: string | null;
  readonly stdinIsTty: boolean;
}): string {
  if (input.inputFormat === 'stream-json') {
    if (input.promptArg !== null) {
      throw new OpenPError('--input-format stream-json does not accept prompt arguments', EXIT_CODES.usage);
    }
    if (input.stdinIsTty || input.stdinText === null) {
      throw new OpenPError('--input-format stream-json requires stdin', EXIT_CODES.usage);
    }
    return parseStreamJsonPrompt(input.stdinText);
  }

  if (input.promptArg !== null) {
    return input.promptArg;
  }
  if (input.stdinIsTty || input.stdinText === null) {
    throw new OpenPError('prompt is required', EXIT_CODES.usage);
  }
  if (!input.stdinText.trim()) {
    throw new OpenPError('prompt is required', EXIT_CODES.usage);
  }
  return input.stdinText;
}

export function parseStreamJsonPrompt(input: string): string {
  let prompt: string | null = null;
  let userEventCount = 0;

  for (const [index, line] of input.split(/\r?\n/).entries()) {
    const userEvent = parseStreamJsonUserEventLine(line, index + 1);
    if (!userEvent) {
      continue;
    }
    userEventCount += 1;
    if (userEventCount > 1) {
      throw new OpenPError('--input-format stream-json requires exactly one user event', EXIT_CODES.usage);
    }
    prompt = userEvent.text;
  }

  if (userEventCount !== 1 || prompt === null) {
    throw new OpenPError('--input-format stream-json requires exactly one user event', EXIT_CODES.usage);
  }
  if (!prompt.trim()) {
    throw new OpenPError('stream-json user event text is empty', EXIT_CODES.usage);
  }
  return prompt;
}

export function parseStreamJsonUserEventLine(line: string, lineNumber: number): StreamJsonUserEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const event = parseJsonObject(trimmed, lineNumber);
  if (event.type !== 'user') {
    throw new OpenPError(`unsupported stream-json input event: ${String(event.type)}`, EXIT_CODES.usage);
  }
  const text = extractStreamJsonUserText(event);
  if (!text.trim()) {
    throw new OpenPError('stream-json user event text is empty', EXIT_CODES.usage);
  }
  return {
    text,
    turnId: extractStreamJsonTurnId(event),
  };
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseTimeoutMs(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new OpenPError(`invalid timeout: ${value}`, EXIT_CODES.usage);
  }
  return Math.ceil(seconds * 1000);
}

function validateSessionId(value: string, flag: string): void {
  if (!isSafeSessionId(value)) {
    throw new OpenPError(`invalid ${flag}: expected safe session id`, EXIT_CODES.usage);
  }
}

function parseJsonObject(line: string, lineNumber: number): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    throw new OpenPError(`invalid stream-json input line ${lineNumber}`, EXIT_CODES.usage);
  }
  throw new OpenPError(`invalid stream-json input line ${lineNumber}`, EXIT_CODES.usage);
}

function extractStreamJsonUserText(event: Record<string, unknown>): string {
  const message = asObject(event.message);
  if (!message) {
    throw new OpenPError('stream-json user event requires message object', EXIT_CODES.usage);
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new OpenPError('stream-json user event requires text content', EXIT_CODES.usage);
  }

  const parts: string[] = [];
  for (const block of content) {
    const item = asObject(block);
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      throw new OpenPError('stream-json user event supports text content only', EXIT_CODES.usage);
    }
    parts.push(item.text);
  }
  return parts.join('');
}

function extractStreamJsonTurnId(event: Record<string, unknown>): string | null {
  const turnId = event.turnId ?? event.turn_id;
  return typeof turnId === 'string' && turnId.trim() ? turnId : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
