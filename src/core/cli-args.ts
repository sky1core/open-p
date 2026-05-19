import { randomUUID } from 'node:crypto';
import { stdin } from 'node:process';
import { EXIT_CODES, OpenPError } from './errors.js';
import { parseJsonSchemaText } from './json-schema.js';
import type { OutputFormat } from './output.js';

export type InputFormat = 'text' | 'stream-json';

export interface CliOptions {
  readonly backend: string;
  readonly provider: string;
  readonly backendSessionId: string;
  readonly resume: boolean;
  readonly timeoutMs: number;
  readonly inputFormat: InputFormat;
  readonly outputFormat: OutputFormat;
  readonly debugLog: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly appendSystemPrompt: string | null;
  readonly jsonSchema: string | null;
  readonly includePartialMessages: boolean;
  readonly backendArgs: readonly string[];
  readonly promptArg: string | null;
  readonly turnId: string;
}

export interface StreamJsonUserEvent {
  readonly text: string;
  readonly turnId: string | null;
}

const VALUE_FLAGS = new Set([
  '--backend',
  '--provider',
  '--session-id',
  '--resume',
  '--timeout',
  '--input-format',
  '--output-format',
  '--debug-log',
  '--model',
  '--permission-mode',
  '--append-system-prompt',
  '--system-prompt',
  '--json-schema',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--effort',
  '--mcp-config',
  '--settings',
  '--setting-sources',
  '--add-dir',
]);

const BACKEND_PASS_THROUGH_VALUE_FLAGS = new Set([
  '--system-prompt',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--effort',
  '--mcp-config',
  '--settings',
  '--setting-sources',
  '--add-dir',
]);

const BACKEND_PASS_THROUGH_BOOLEAN_FLAGS = new Set([
  '--verbose',
  '--brief',
  '--include-partial-messages',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]);

export function parseCliArgs(argv: readonly string[], knownBackends?: ReadonlySet<string>): CliOptions {
  let backend: string | null = null;
  let provider: CliOptions['provider'] = 'tmux';
  let backendSessionId: string | null = null;
  let resume = false;
  let timeoutMs = 120_000;
  let inputFormat: InputFormat = 'text';
  let outputFormat: CliOptions['outputFormat'] = 'text';
  let debugLog: string | null = null;
  let model: string | null = null;
  let permissionMode: string | null = null;
  let appendSystemPrompt: string | null = null;
  let jsonSchema: string | null = null;
  let includePartialMessages = false;
  const backendArgs: string[] = [];
  const promptParts: string[] = [];

  const separatorIndex = argv.indexOf('--');
  const hasBackendFlag = argv.some((a, i) => a === '--backend' && i < argv.length - 1 && (separatorIndex === -1 || i < separatorIndex));
  let subcommandConsumed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') {
      promptParts.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      if (!subcommandConsumed && !hasBackendFlag && knownBackends) {
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
    if (BACKEND_PASS_THROUGH_BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--include-partial-messages') {
        includePartialMessages = true;
        continue;
      }
      if (arg === '--dangerously-skip-permissions') {
        permissionMode = 'bypassPermissions';
        continue;
      }
      backendArgs.push(arg);
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new OpenPError(`unsupported option: ${arg}`, EXIT_CODES.unsupportedOption);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new OpenPError(`missing value for ${arg}`, EXIT_CODES.usage);
    }
    if (value.length === 0 && !BACKEND_PASS_THROUGH_VALUE_FLAGS.has(arg)) {
      throw new OpenPError(`missing value for ${arg}`, EXIT_CODES.usage);
    }
    i += 1;
    switch (arg) {
      case '--backend':
        if (knownBackends && !knownBackends.has(value)) {
          const available = [...knownBackends].join(', ');
          throw new OpenPError(`unknown backend: ${value} (available: ${available})`, EXIT_CODES.unsupportedOption);
        }
        backend = value;
        break;
      case '--provider':
        if (value !== 'tmux') {
          throw new OpenPError(`unsupported provider: ${value}`, EXIT_CODES.unsupportedOption);
        }
        provider = value;
        break;
      case '--session-id':
        validateSessionId(value, arg);
        backendSessionId = value;
        resume = false;
        break;
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
      case '--debug-log':
        debugLog = value;
        break;
      case '--model':
        model = value;
        break;
      case '--permission-mode':
        permissionMode = value;
        break;
      case '--append-system-prompt':
        appendSystemPrompt = value;
        break;
      case '--json-schema':
        parseJsonSchemaText(value);
        jsonSchema = value;
        break;
      case '--system-prompt':
      case '--allowedTools':
      case '--allowed-tools':
      case '--disallowedTools':
      case '--disallowed-tools':
      case '--tools':
      case '--effort':
      case '--mcp-config':
      case '--settings':
      case '--setting-sources':
      case '--add-dir':
        backendArgs.push(arg, value);
        break;
    }
  }

  if (includePartialMessages && outputFormat !== 'stream-json') {
    throw new OpenPError('--include-partial-messages requires --output-format stream-json', EXIT_CODES.usage);
  }

  if (!backend) {
    if (knownBackends) {
      const available = [...knownBackends].join(', ');
      throw new OpenPError(`backend is required: specify as first argument or use --backend (available: ${available})`, EXIT_CODES.usage);
    }
    backend = 'claude-code';
  }

  return {
    backend,
    provider,
    backendSessionId: backendSessionId ?? randomUUID(),
    resume,
    timeoutMs,
    inputFormat,
    outputFormat,
    debugLog,
    model,
    permissionMode,
    appendSystemPrompt,
    jsonSchema,
    includePartialMessages,
    backendArgs,
    promptArg: promptParts.length > 0 ? promptParts.join(' ') : null,
    turnId: randomUUID(),
  };
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OpenPError(`invalid ${flag}: expected UUID`, EXIT_CODES.usage);
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
