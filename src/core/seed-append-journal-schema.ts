import type { NativeTurnIds } from './backend.js';
import { EXIT_CODES, OpenPError, type ExitCode } from './errors.js';
import { isNativeStateDigest } from './native-state-digest.js';
import { contentDigest, isLogicalSeedId } from './seed-ir.js';
import type { SeedProvenanceSource } from './seed-provenance.js';
import { isSafeSessionId } from './session-id.js';
import { isCanonicalUuidV4 } from './uuid.js';

export interface SeedAppendNativeFingerprint {
  readonly contentDigest: string;
  readonly nativeIds: NativeTurnIds;
}

export interface SeedAppendJournalTurn {
  readonly logicalId: string;
  readonly contentDigest: string;
  readonly source: SeedProvenanceSource;
  readonly nativeIds: NativeTurnIds;
}

export interface SeedAppendJournal {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly cleanupToken: string | null;
  readonly backend: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly base: {
    readonly native: readonly SeedAppendNativeFingerprint[];
    readonly nativeStateDigest: string;
    readonly provenanceDigest: string;
    readonly provenanceEntryCount: number;
  };
  readonly candidateNativeStateDigest: string;
  readonly planned: readonly SeedAppendJournalTurn[];
}

interface JsonObject {
  readonly [key: string]: unknown;
}

export function parseSeedAppendJournal(value: unknown, path: string): SeedAppendJournal {
  const object = exactObject(value, [
    'schemaVersion',
    'operationId',
    'cleanupToken',
    'backend',
    'sessionId',
    'createdAt',
    'base',
    'candidateNativeStateDigest',
    'planned',
  ]);
  if (!object || object.schemaVersion !== 1 || !isCanonicalUuidV4(object.operationId) ||
    !(object.cleanupToken === null || isCanonicalUuidV4(object.cleanupToken)) ||
    !nonEmptyString(object.backend) || !nonEmptyString(object.sessionId) ||
    !canonicalIsoDate(object.createdAt)) {
    throw stateError(`invalid pending seed journal: ${path}`);
  }
  assertSafeIdentity(object.backend, object.sessionId, path);
  const baseObject = exactObject(object.base, [
    'native',
    'nativeStateDigest',
    'provenanceDigest',
    'provenanceEntryCount',
  ]);
  if (!baseObject || !Array.isArray(baseObject.native) || !sha256(baseObject.provenanceDigest) ||
    !isNativeStateDigest(baseObject.nativeStateDigest) ||
    !Number.isSafeInteger(baseObject.provenanceEntryCount) || (baseObject.provenanceEntryCount as number) < 0 ||
    !isNativeStateDigest(object.candidateNativeStateDigest) ||
    baseObject.nativeStateDigest === object.candidateNativeStateDigest ||
    !Array.isArray(object.planned) || object.planned.length === 0) {
    throw stateError(`invalid pending seed journal: ${path}`);
  }
  const native = baseObject.native.map((item) => parseFingerprint(item, path));
  const planned = object.planned.map((item) => parsePlannedTurn(item, path));
  const logicalIds = new Set<string>();
  const allNativeIds = new Set<string>();
  for (const turn of native) {
    rememberUniqueIds(turn.nativeIds, allNativeIds, path);
  }
  for (const turn of planned) {
    if (logicalIds.has(turn.logicalId)) {
      throw stateError(`invalid pending seed journal: ${path}`);
    }
    logicalIds.add(turn.logicalId);
    rememberUniqueIds(turn.nativeIds, allNativeIds, path);
  }
  return {
    schemaVersion: 1,
    operationId: object.operationId,
    cleanupToken: object.cleanupToken,
    backend: object.backend,
    sessionId: object.sessionId,
    createdAt: object.createdAt,
    base: {
      native,
      nativeStateDigest: baseObject.nativeStateDigest,
      provenanceDigest: baseObject.provenanceDigest as string,
      provenanceEntryCount: baseObject.provenanceEntryCount as number,
    },
    candidateNativeStateDigest: object.candidateNativeStateDigest,
    planned,
  };
}

export function sameSeedAppendJournal(a: SeedAppendJournal, b: SeedAppendJournal): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function cloneNativeTurnIds(ids: NativeTurnIds): NativeTurnIds {
  return { userId: ids.userId, assistantIds: [...ids.assistantIds], completionId: ids.completionId };
}

export function sameNativeTurnIds(a: NativeTurnIds, b: NativeTurnIds): boolean {
  return a.userId === b.userId && a.completionId === b.completionId &&
    a.assistantIds.length === b.assistantIds.length &&
    a.assistantIds.every((id, index) => id === b.assistantIds[index]);
}

export function assertSeedAppendNativeIds(ids: NativeTurnIds, source: string, exitCode: ExitCode): void {
  if (ids.userId.length === 0 || ids.completionId.length === 0 || ids.assistantIds.length === 0 ||
    ids.assistantIds.some((id) => id.length === 0) ||
    new Set(ids.assistantIds).size !== ids.assistantIds.length ||
    ids.assistantIds.includes(ids.userId) || ids.completionId === ids.userId) {
    throw new OpenPError(`${source} contains invalid native ids`, exitCode);
  }
}

export function uniqueNativeTurnIds(ids: NativeTurnIds): ReadonlySet<string> {
  return new Set([ids.userId, ...ids.assistantIds, ids.completionId]);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseFingerprint(value: unknown, path: string): SeedAppendNativeFingerprint {
  const object = exactObject(value, ['contentDigest', 'nativeIds']);
  if (!object || !sha256(object.contentDigest)) {
    throw stateError(`invalid pending seed journal: ${path}`);
  }
  return {
    contentDigest: object.contentDigest as string,
    nativeIds: parseNativeIds(object.nativeIds, path),
  };
}

function parsePlannedTurn(value: unknown, path: string): SeedAppendJournalTurn {
  const object = exactObject(value, ['logicalId', 'contentDigest', 'source', 'nativeIds']);
  if (!object || !isLogicalSeedId(object.logicalId) || !sha256(object.contentDigest)) {
    throw stateError(`invalid pending seed journal: ${path}`);
  }
  return {
    logicalId: object.logicalId,
    contentDigest: object.contentDigest as string,
    source: parseSource(object.source, path),
    nativeIds: parseNativeIds(object.nativeIds, path),
  };
}

function parseSource(value: unknown, path: string): SeedProvenanceSource {
  const object = asObject(value);
  if (object?.kind === 'native') {
    const native = exactObject(value, ['kind', 'backend', 'sessionId', 'nativeIds']);
    if (!native || !nonEmptyString(native.backend) || !nonEmptyString(native.sessionId) ||
      !isSafeSessionId(native.sessionId)) {
      throw stateError(`invalid pending seed journal: ${path}`);
    }
    return {
      kind: 'native',
      backend: native.backend,
      sessionId: native.sessionId,
      nativeIds: parseNativeIds(native.nativeIds, path),
    };
  }
  if (object?.kind === 'external-ir') {
    const external = exactObject(value, ['kind', 'documentDigest', 'externalIdDigest']);
    if (!external || !sha256(external.documentDigest) || !sha256(external.externalIdDigest)) {
      throw stateError(`invalid pending seed journal: ${path}`);
    }
    return {
      kind: 'external-ir',
      documentDigest: external.documentDigest as string,
      externalIdDigest: external.externalIdDigest as string,
    };
  }
  throw stateError(`invalid pending seed journal: ${path}`);
}

function parseNativeIds(value: unknown, path: string): NativeTurnIds {
  const object = exactObject(value, ['userId', 'assistantIds', 'completionId']);
  if (!object || !nonEmptyString(object.userId) || !nonEmptyString(object.completionId) ||
    !Array.isArray(object.assistantIds) || object.assistantIds.length === 0 ||
    !object.assistantIds.every(nonEmptyString)) {
    throw stateError(`invalid pending seed journal: ${path}`);
  }
  const ids = {
    userId: object.userId,
    assistantIds: object.assistantIds as string[],
    completionId: object.completionId,
  };
  assertSeedAppendNativeIds(ids, path, EXIT_CODES.sessionState);
  return ids;
}

function rememberUniqueIds(ids: NativeTurnIds, seen: Set<string>, path: string): void {
  for (const id of uniqueNativeTurnIds(ids)) {
    if (seen.has(id)) {
      throw stateError(`invalid pending seed journal: ${path}`);
    }
    seen.add(id);
  }
}

function exactObject(value: unknown, keys: readonly string[]): JsonObject | null {
  const object = asObject(value);
  if (!object) {
    return null;
  }
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? object
    : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function canonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertSafeIdentity(backend: string, sessionId: string, source: string): void {
  if (backend.length === 0 || !isSafeSessionId(sessionId)) {
    throw stateError(`invalid ${source} identity`);
  }
}

function stateError(message: string): OpenPError {
  return new OpenPError(message, EXIT_CODES.sessionState);
}
