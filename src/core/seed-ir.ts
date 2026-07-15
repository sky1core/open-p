import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { NativeSessionReadResult, NativeSessionTurn, NativeTurnIds, SeedWriteTurn } from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';

export interface ExternalSeedIr {
  readonly schemaVersion: 1;
  readonly documentDigest: string;
  readonly turns: readonly ExternalSeedIrTurn[];
}

export interface ExternalSeedIrTurn {
  readonly externalId: string;
  readonly logicalId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly contentDigest: string;
}

export interface LogicalSeedTurn {
  readonly logicalId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly contentDigest: string;
  readonly nativeIds: NativeTurnIds | null;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

export async function loadExternalSeedIrFile(path: string): Promise<ExternalSeedIr> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw usage(`failed to read IR file: ${path}`);
  }
  return parseExternalSeedIrJson(text, path);
}

export function parseExternalSeedIrJson(text: string, sourcePath: string): ExternalSeedIr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usage(`invalid IR file (not JSON): ${sourcePath}`);
  }
  if (!isPlainObject(parsed)) {
    throw usage(`invalid IR file (expected a JSON object): ${sourcePath}`);
  }
  assertExactKeys(parsed, ['schemaVersion', 'turns'], `invalid IR file (unexpected top-level keys): ${sourcePath}`);
  if (parsed.schemaVersion !== 1) {
    throw usage(`invalid IR file (schemaVersion must be 1): ${sourcePath}`);
  }
  if (!Array.isArray(parsed.turns) || parsed.turns.length === 0) {
    throw usage(`invalid IR file ("turns" must be a non-empty array): ${sourcePath}`);
  }

  const documentDigest = digestText('openp.seed.external.document.v1', text);
  const seen = new Set<string>();
  const turns = parsed.turns.map((turn, index) => parseExternalTurn(turn, index, sourcePath, documentDigest, seen));
  return { schemaVersion: 1, documentDigest, turns };
}

export function nativeLogicalId(backend: string, sessionId: string, nativeIds: NativeTurnIds): string {
  return `native:${digestJson('openp.seed.native.logical.v1', {
    backend,
    sessionId,
    userId: nativeIds.userId,
    assistantIds: [...nativeIds.assistantIds],
    completionId: nativeIds.completionId,
  })}`;
}

export function contentDigest(userText: string, assistantText: string): string {
  return digestJson('openp.seed.turn.content.v1', { userText, assistantText });
}

export function externalIrLogicalId(documentDigest: string, externalId: string): string {
  return `ir:${digestJson('openp.seed.external.logical.v1', { documentDigest, externalId })}`;
}

export function logicalTurnsFromNative(read: NativeSessionReadResult): readonly LogicalSeedTurn[] {
  return read.turns.map((turn) => nativeTurnToLogical(read.backend, read.sessionId, turn));
}

export function nativeTurnToLogical(backend: string, sessionId: string, turn: NativeSessionTurn): LogicalSeedTurn {
  const digest = contentDigest(turn.userText, turn.assistantText);
  return {
    logicalId: nativeLogicalId(backend, sessionId, turn.nativeIds),
    userText: turn.userText,
    assistantText: turn.assistantText,
    contentDigest: digest,
    nativeIds: turn.nativeIds,
  };
}

export function logicalTurnsFromExternalIr(ir: ExternalSeedIr): readonly LogicalSeedTurn[] {
  return ir.turns.map((turn) => ({
    logicalId: turn.logicalId,
    userText: turn.userText,
    assistantText: turn.assistantText,
    contentDigest: turn.contentDigest,
    nativeIds: null,
  }));
}

export function toSeedWriteTurns(turns: readonly LogicalSeedTurn[]): readonly SeedWriteTurn[] {
  return turns.map((turn) => ({
    logicalId: turn.logicalId,
    userText: turn.userText,
    assistantText: turn.assistantText,
    contentDigest: turn.contentDigest,
    sourceNativeIds: turn.nativeIds,
  }));
}

function parseExternalTurn(
  value: unknown,
  index: number,
  sourcePath: string,
  documentDigest: string,
  seen: Set<string>,
): ExternalSeedIrTurn {
  if (!isPlainObject(value)) {
    throw usage(`invalid IR file (turn ${index} must be an object): ${sourcePath}`);
  }
  assertExactKeys(value, ['assistant', 'id', 'user'], `invalid IR file (turn ${index} has unexpected keys): ${sourcePath}`);
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw usage(`invalid IR file (turn ${index} id must be a non-empty string): ${sourcePath}`);
  }
  if (seen.has(value.id)) {
    throw usage(`invalid IR file (turn id is not unique): ${sourcePath}`);
  }
  seen.add(value.id);
  const userText = parseTextObject(value.user, index, 'user', sourcePath);
  const assistantText = parseTextObject(value.assistant, index, 'assistant', sourcePath);
  return {
    externalId: value.id,
    logicalId: externalIrLogicalId(documentDigest, value.id),
    userText,
    assistantText,
    contentDigest: contentDigest(userText, assistantText),
  };
}

function parseTextObject(value: unknown, index: number, role: 'user' | 'assistant', sourcePath: string): string {
  if (!isPlainObject(value)) {
    throw usage(`invalid IR file (turn ${index} ${role} must be an object): ${sourcePath}`);
  }
  assertExactKeys(value, ['text'], `invalid IR file (turn ${index} ${role} has unexpected keys): ${sourcePath}`);
  if (typeof value.text !== 'string' || value.text.length === 0) {
    throw usage(`invalid IR file (turn ${index} ${role}.text must be a non-empty string): ${sourcePath}`);
  }
  return value.text;
}

function assertExactKeys(value: JsonObject, expected: readonly string[], message: string): void {
  const keys = Object.keys(value).sort();
  const want = [...expected].sort();
  if (keys.length !== want.length || keys.some((key, index) => key !== want[index])) {
    throw usage(message);
  }
}

function digestText(domain: string, text: string): string {
  return createHash('sha256').update(domain).update('\0').update(text).digest('hex');
}

function digestJson(domain: string, value: unknown): string {
  return digestText(domain, JSON.stringify(value));
}

function usage(message: string): OpenPError {
  return new OpenPError(message, EXIT_CODES.usage);
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
