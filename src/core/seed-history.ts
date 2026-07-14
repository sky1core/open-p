import { readFile } from 'node:fs/promises';
import { EXIT_CODES, OpenPError } from './errors.js';
import type { SessionHistoryTurn } from './backend.js';

// Parses the caller-supplied `--history` file. Validation is strict with no implicit coercion:
// the top level must be exactly `{"turns": [...]}`, each turn exactly `{role, text}`, role one of
// user/assistant, and text a non-empty string (no trimming). Every violation is a usage error.
export function parseSeedHistoryJson(text: string, sourcePath: string): readonly SessionHistoryTurn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usage(`invalid history file (not JSON): ${sourcePath}`);
  }
  if (!isPlainObject(parsed)) {
    throw usage(`invalid history file (expected a JSON object): ${sourcePath}`);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'turns') {
    throw usage(`invalid history file (expected exactly one key "turns"): ${sourcePath}`);
  }
  const turns = parsed.turns;
  if (!Array.isArray(turns) || turns.length === 0) {
    throw usage(`invalid history file ("turns" must be a non-empty array): ${sourcePath}`);
  }
  return turns.map((turn, index) => parseTurn(turn, index, sourcePath));
}

export async function loadSeedHistoryFile(path: string): Promise<readonly SessionHistoryTurn[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw usage(`failed to read history file: ${path}`);
  }
  return parseSeedHistoryJson(text, path);
}

function parseTurn(value: unknown, index: number, sourcePath: string): SessionHistoryTurn {
  if (!isPlainObject(value)) {
    throw usage(`invalid history file (turn ${index} must be an object): ${sourcePath}`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'role' || keys[1] !== 'text') {
    throw usage(`invalid history file (turn ${index} must have exactly "role" and "text"): ${sourcePath}`);
  }
  const { role, text } = value;
  if (role !== 'user' && role !== 'assistant') {
    throw usage(`invalid history file (turn ${index} role must be "user" or "assistant"): ${sourcePath}`);
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw usage(`invalid history file (turn ${index} text must be a non-empty string): ${sourcePath}`);
  }
  return { role, text };
}

function usage(message: string): OpenPError {
  return new OpenPError(message, EXIT_CODES.usage);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
