import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';

const SETTINGS_FLAG = '--settings';

export function withThinkingSummariesSettings(args: readonly string[], cwd: string): string[] {
  const settingsInputs: SettingsInput[] = [];
  const passthroughArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg !== SETTINGS_FLAG) {
      passthroughArgs.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      passthroughArgs.push(arg);
      continue;
    }
    settingsInputs.push(parseSettingsInput(value));
    index += 1;
  }

  const mergedSettings = {
    ...mergeSettingsValues(settingsInputs, cwd),
    showThinkingSummaries: true,
  };
  return [
    SETTINGS_FLAG,
    formatSettingsArg(mergedSettings, settingsInputs.some((input) => input.kind === 'file')),
    ...passthroughArgs,
  ];
}

interface SettingsInput {
  readonly kind: 'inline' | 'file';
  readonly value: string;
}

function parseSettingsInput(value: string): SettingsInput {
  return {
    kind: value.trim().startsWith('{') ? 'inline' : 'file',
    value,
  };
}

function mergeSettingsValues(values: readonly SettingsInput[], cwd: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const input of values) {
    Object.assign(merged, loadSettingsValue(input, cwd));
  }
  return merged;
}

function loadSettingsValue(input: SettingsInput, cwd: string): Record<string, unknown> {
  const source = input.kind === 'inline'
    ? input.value
    : readFileSync(resolve(cwd, input.value), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(source));
  } catch (error) {
    throw new OpenPError(`invalid --settings JSON: ${error instanceof Error ? error.message : String(error)}`, EXIT_CODES.usage);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OpenPError('--settings must be a JSON object', EXIT_CODES.usage);
  }
  return parsed as Record<string, unknown>;
}

function stripJsonc(source: string): string {
  return stripTrailingCommas(stripJsoncComments(source));
}

function stripJsoncComments(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      if (index < source.length) {
        output += source[index];
      }
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function stripTrailingCommas(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead]!)) {
        lookahead += 1;
      }
      if (source[lookahead] === '}' || source[lookahead] === ']') {
        continue;
      }
    }
    output += char;
  }
  return output;
}

function formatSettingsArg(settings: Record<string, unknown>, useFile: boolean): string {
  const text = JSON.stringify(settings);
  if (!useFile) {
    return text;
  }
  const dir = mkdtempSync(join(tmpdir(), 'openp-claude-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}
