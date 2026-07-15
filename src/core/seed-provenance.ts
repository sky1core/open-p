import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeSessionReadResult, NativeTurnIds, NativeWrittenTurn } from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import { ensureDurableDirectory, syncDirectory } from './fs-durability.js';
import {
  contentDigest,
  isLogicalSeedId,
  logicalTurnsFromNative,
  nativeLogicalId,
  type LogicalSeedTurn,
} from './seed-ir.js';
import { isSafeSessionId } from './session-id.js';
import { resolveOpenPStateRoot } from './state-root.js';

export interface NativeTurnRef {
  readonly kind: 'native';
  readonly backend: string;
  readonly sessionId: string;
  readonly nativeIds: NativeTurnIds;
}

export interface ExternalTurnRef {
  readonly kind: 'external-ir';
  readonly documentDigest: string;
  readonly externalIdDigest: string;
}

export type SeedProvenanceSource = NativeTurnRef | ExternalTurnRef;

export interface SeedProvenanceEntry {
  readonly logicalId: string;
  readonly contentDigest: string;
  readonly source: SeedProvenanceSource;
  readonly target: NativeTurnRef;
}

export interface SeedProvenanceState {
  readonly schemaVersion: 1;
  readonly backend: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly bootstrap: readonly NativeTurnIds[];
  readonly entries: readonly SeedProvenanceEntry[];
}

interface JsonObject {
  readonly [key: string]: unknown;
}

export class SeedProvenanceStore {
  private readonly stateRoot: string;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.stateRoot = stateRoot;
  }

  pathForSession(backend: string, sessionId: string): string {
    assertSafeSessionId(sessionId);
    return join(this.stateRoot, 'seed-provenance', `${backendKey(backend)}-${sessionId}.json`);
  }

  async load(backend: string, sessionId: string): Promise<SeedProvenanceState | null> {
    const path = this.pathForSession(backend, sessionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new OpenPError(`failed to read seed provenance: ${path}`, EXIT_CODES.sessionState);
    }
    if (!isUtf8(bytes)) {
      throw invalidProvenance(path);
    }
    const text = bytes.toString('utf8');
    try {
      const state = parseState(JSON.parse(text), path);
      if (state.backend !== backend || state.sessionId !== sessionId) {
        throw invalidProvenance(path);
      }
      return state;
    } catch (error) {
      if (error instanceof OpenPError) {
        throw error;
      }
      throw new OpenPError(`failed to parse seed provenance: ${path}`, EXIT_CODES.sessionState);
    }
  }

  async save(state: SeedProvenanceState): Promise<void> {
    const checked = parseState(state, 'seed provenance input');
    assertSafeSessionId(checked.sessionId);
    const directory = join(this.stateRoot, 'seed-provenance');
    const path = this.pathForSession(checked.backend, checked.sessionId);
    const tempPath = join(directory, `.seed-provenance-${randomUUID()}.tmp`);
    try {
      await ensureDurableDirectory(directory);
      const file = await open(tempPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(checked, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tempPath, path);
      await chmod(path, 0o600).catch(() => undefined);
      await syncDirectory(directory);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (error instanceof OpenPError) throw error;
      throw new OpenPError(`failed to write seed provenance: ${path}`, EXIT_CODES.sessionState);
    }
  }
}

export function createInitialProvenanceState(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly bootstrap: readonly NativeTurnIds[];
}): SeedProvenanceState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    backend: input.backend,
    sessionId: input.sessionId,
    createdAt: now,
    updatedAt: now,
    bootstrap: input.bootstrap,
    entries: [],
  };
}

export function withAppendedProvenanceEntries(
  state: SeedProvenanceState | null,
  input: {
    readonly targetBackend: string;
    readonly targetSessionId: string;
    readonly bootstrap?: readonly NativeTurnIds[];
    readonly sourceRefs: readonly SeedProvenanceSource[];
    readonly written: readonly NativeWrittenTurn[];
  },
): SeedProvenanceState {
  const now = new Date().toISOString();
  const base: SeedProvenanceState = state ?? {
    schemaVersion: 1,
    backend: input.targetBackend,
    sessionId: input.targetSessionId,
    createdAt: now,
    updatedAt: now,
    bootstrap: input.bootstrap ?? [],
    entries: [],
  };
  if (base.backend !== input.targetBackend || base.sessionId !== input.targetSessionId) {
    throw new OpenPError(`seed provenance belongs to ${base.backend}/${base.sessionId}`, EXIT_CODES.sessionState);
  }
  if (input.sourceRefs.length !== input.written.length) {
    throw new OpenPError('writer returned a different number of seeded turns', EXIT_CODES.protocolViolation);
  }
  const additions = input.written.map((written, index): SeedProvenanceEntry => ({
    logicalId: written.logicalId,
    contentDigest: written.contentDigest,
    source: input.sourceRefs[index]!,
    target: {
      kind: 'native',
      backend: input.targetBackend,
      sessionId: input.targetSessionId,
      nativeIds: written.nativeIds,
    },
  }));
  const next = {
    ...base,
    updatedAt: now,
    bootstrap: input.bootstrap ?? base.bootstrap,
    entries: [...base.entries, ...additions],
  };
  assertProvenanceEntryIntegrity(next);
  return next;
}

export function externalSourceRefs(documentDigest: string, externalIds: readonly string[]): readonly ExternalTurnRef[] {
  return externalIds.map((externalId) => ({
    kind: 'external-ir',
    documentDigest,
    externalIdDigest: digestExternalId(documentDigest, externalId),
  }));
}

export function nativeSourceRefs(
  backend: string,
  sessionId: string,
  turns: readonly LogicalSeedTurn[],
): readonly NativeTurnRef[] {
  return turns.map((turn) => {
    if (!turn.nativeIds) {
      throw new OpenPError('native source turn is missing native ids', EXIT_CODES.protocolViolation);
    }
    return { kind: 'native', backend, sessionId, nativeIds: turn.nativeIds };
  });
}

export function normalizeNativeReadWithProvenance(
  read: NativeSessionReadResult,
  provenance: SeedProvenanceState | null,
): readonly LogicalSeedTurn[] {
  const baseTurns = logicalTurnsFromNative(read);
  if (!provenance) {
    return baseTurns;
  }
  if (provenance.backend !== read.backend || provenance.sessionId !== read.sessionId) {
    throw new OpenPError(`seed provenance does not belong to ${read.backend}/${read.sessionId}`, EXIT_CODES.sessionState);
  }
  assertProvenanceEntryIntegrity(provenance);
  assertAllProvenanceMappingsPresentInOrder(read, provenance);
  const result: LogicalSeedTurn[] = [];
  for (const turn of read.turns) {
    if (isBootstrapTurn(provenance.bootstrap, turn.nativeIds)) {
      continue;
    }
    const digest = contentDigest(turn.userText, turn.assistantText);
    const match = findProvenanceMatch(provenance, read.backend, read.sessionId, turn.nativeIds, digest);
    if (match) {
      result.push({
        logicalId: match.logicalId,
        userText: turn.userText,
        assistantText: turn.assistantText,
        contentDigest: digest,
        nativeIds: turn.nativeIds,
      });
    } else {
      result.push({
        logicalId: nativeLogicalId(read.backend, read.sessionId, turn.nativeIds),
        userText: turn.userText,
        assistantText: turn.assistantText,
        contentDigest: digest,
        nativeIds: turn.nativeIds,
      });
    }
  }
  const logicalIds = new Set<string>();
  for (const turn of result) {
    if (logicalIds.has(turn.logicalId)) {
      throw new OpenPError('seed provenance produced duplicate logical turn ids', EXIT_CODES.protocolViolation);
    }
    logicalIds.add(turn.logicalId);
  }
  return result;
}

function assertProvenanceEntryIntegrity(provenance: SeedProvenanceState): void {
  const logicalIds = new Set<string>();
  const ownedTargets: NativeTurnIds[] = [];
  for (let index = 0; index < provenance.bootstrap.length; index += 1) {
    const ids = provenance.bootstrap[index]!;
    if (provenance.bootstrap.slice(0, index).some((other) => overlapsNativeIds(other, ids))) {
      throw new OpenPError('seed provenance bootstrap native ids overlap', EXIT_CODES.protocolViolation);
    }
  }
  for (const entry of provenance.entries) {
    if (entry.target.backend !== provenance.backend || entry.target.sessionId !== provenance.sessionId) {
      throw new OpenPError('seed provenance target belongs to a different native session', EXIT_CODES.protocolViolation);
    }
    if (logicalIds.has(entry.logicalId)) {
      throw new OpenPError('seed provenance contains duplicate logical turn ids', EXIT_CODES.protocolViolation);
    }
    if (ownedTargets.some((ids) => overlapsNativeIds(ids, entry.target.nativeIds))) {
      throw new OpenPError('seed provenance target mappings overlap', EXIT_CODES.protocolViolation);
    }
    if (provenance.bootstrap.some((ids) => overlapsNativeIds(ids, entry.target.nativeIds))) {
      throw new OpenPError('seed provenance target mapping overlaps bootstrap native ids', EXIT_CODES.protocolViolation);
    }
    if (entry.source.kind === 'native' && entry.source.backend === provenance.backend &&
      entry.source.sessionId === provenance.sessionId) {
      throw new OpenPError('seed provenance source cannot claim the target native session', EXIT_CODES.protocolViolation);
    }
    logicalIds.add(entry.logicalId);
    ownedTargets.push(entry.target.nativeIds);
  }
}

function assertAllProvenanceMappingsPresentInOrder(
  read: NativeSessionReadResult,
  provenance: SeedProvenanceState,
): void {
  let previousMappingIndex = -1;
  for (const bootstrap of provenance.bootstrap) {
    const bootstrapIndex = read.turns.findIndex((turn) => sameNativeIds(bootstrap, turn.nativeIds));
    if (bootstrapIndex < 0) {
      throw new OpenPError('seed bootstrap provenance mapping is missing from the native session', EXIT_CODES.protocolViolation);
    }
    if (bootstrapIndex <= previousMappingIndex) {
      throw new OpenPError('seed bootstrap provenance mapping order differs from the native session', EXIT_CODES.protocolViolation);
    }
    previousMappingIndex = bootstrapIndex;
  }
  for (const entry of provenance.entries) {
    const target = entry.target;
    const targetIndex = read.turns.findIndex((turn) => sameNativeIds(target.nativeIds, turn.nativeIds));
    if (targetIndex < 0) {
      throw new OpenPError('seed provenance target mapping is missing from the native session', EXIT_CODES.protocolViolation);
    }
    if (targetIndex <= previousMappingIndex) {
      throw new OpenPError('seed provenance target mapping order differs from the native session', EXIT_CODES.protocolViolation);
    }
    previousMappingIndex = targetIndex;
  }
}

export function planSeedAppend(
  sourceTurns: readonly LogicalSeedTurn[],
  targetTurns: readonly LogicalSeedTurn[],
): { readonly status: 'noop'; readonly missing: readonly LogicalSeedTurn[] }
  | { readonly status: 'append'; readonly missing: readonly LogicalSeedTurn[] } {
  const sourceIds = sourceTurns.map((turn) => turn.logicalId);
  const targetIds = targetTurns.map((turn) => turn.logicalId);
  const min = Math.min(sourceIds.length, targetIds.length);
  for (let index = 0; index < min; index += 1) {
    if (sourceIds[index] !== targetIds[index] ||
      sourceTurns[index]!.contentDigest !== targetTurns[index]!.contentDigest) {
      throw new OpenPError('seed target diverges from source logical turn sequence', EXIT_CODES.protocolViolation);
    }
  }
  if (targetIds.length > sourceIds.length) {
    throw new OpenPError('seed source is shorter than target logical turn sequence', EXIT_CODES.protocolViolation);
  }
  if (targetIds.length === sourceIds.length) {
    return { status: 'noop', missing: [] };
  }
  return { status: 'append', missing: sourceTurns.slice(targetIds.length) };
}

function findProvenanceMatch(
  provenance: SeedProvenanceState,
  backend: string,
  sessionId: string,
  nativeIds: NativeTurnIds,
  digest: string,
): SeedProvenanceEntry | null {
  let partial = false;
  for (const entry of provenance.entries) {
    const ref = entry.target;
    if (ref.backend !== backend || ref.sessionId !== sessionId) {
      continue;
    }
    if (sameNativeIds(ref.nativeIds, nativeIds)) {
      if (entry.contentDigest !== digest) {
        throw new OpenPError('seed provenance content digest mismatch', EXIT_CODES.protocolViolation);
      }
      return entry;
    }
    if (overlapsNativeIds(ref.nativeIds, nativeIds)) {
      partial = true;
    }
  }
  if (partial) {
    throw new OpenPError('seed provenance partially matches native ids', EXIT_CODES.protocolViolation);
  }
  return null;
}

function isBootstrapTurn(bootstrap: readonly NativeTurnIds[], nativeIds: NativeTurnIds): boolean {
  let partial = false;
  for (const ids of bootstrap) {
    if (sameNativeIds(ids, nativeIds)) {
      return true;
    }
    if (overlapsNativeIds(ids, nativeIds)) {
      partial = true;
    }
  }
  if (partial) {
    throw new OpenPError('seed bootstrap provenance partially matches native ids', EXIT_CODES.protocolViolation);
  }
  return false;
}

function sameNativeIds(a: NativeTurnIds, b: NativeTurnIds): boolean {
  return a.userId === b.userId &&
    a.completionId === b.completionId &&
    a.assistantIds.length === b.assistantIds.length &&
    a.assistantIds.every((id, index) => id === b.assistantIds[index]);
}

function overlapsNativeIds(a: NativeTurnIds, b: NativeTurnIds): boolean {
  const aIds = new Set([a.userId, a.completionId, ...a.assistantIds]);
  return [b.userId, b.completionId, ...b.assistantIds].some((id) => aIds.has(id));
}

function parseState(value: unknown, path: string): SeedProvenanceState {
  const object = exactObject(value, [
    'schemaVersion',
    'backend',
    'sessionId',
    'createdAt',
    'updatedAt',
    'bootstrap',
    'entries',
  ]);
  if (!object || object.schemaVersion !== 1 || !nonEmptyString(object.backend) ||
    !nonEmptyString(object.sessionId) || !isSafeSessionId(object.sessionId) ||
    !validDate(object.createdAt) || !validDate(object.updatedAt) || !Array.isArray(object.bootstrap) ||
    !Array.isArray(object.entries)) {
    throw invalidProvenance(path);
  }
  const state: SeedProvenanceState = {
    schemaVersion: 1,
    backend: object.backend,
    sessionId: object.sessionId,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    bootstrap: object.bootstrap.map((ids) => parseNativeIds(ids, path)),
    entries: object.entries.map((entry) => parseEntry(entry, path)),
  };
  try {
    assertProvenanceEntryIntegrity(state);
  } catch {
    throw invalidProvenance(path);
  }
  return state;
}

function parseEntry(value: unknown, path: string): SeedProvenanceEntry {
  const object = exactObject(value, ['logicalId', 'contentDigest', 'source', 'target']);
  if (!object || !isLogicalSeedId(object.logicalId) || !sha256(object.contentDigest)) {
    throw invalidProvenance(path);
  }
  return {
    logicalId: object.logicalId,
    contentDigest: object.contentDigest,
    source: parseSourceRef(object.source, path),
    target: parseNativeRef(object.target, path),
  };
}

function parseSourceRef(value: unknown, path: string): SeedProvenanceSource {
  const object = asObject(value);
  if (!object || typeof object.kind !== 'string') {
    throw invalidProvenance(path);
  }
  if (object.kind === 'native') {
    return parseNativeRef(value, path);
  }
  const external = exactObject(value, ['kind', 'documentDigest', 'externalIdDigest']);
  if (external?.kind === 'external-ir' && sha256(external.documentDigest) &&
    sha256(external.externalIdDigest)) {
    return {
      kind: 'external-ir',
      documentDigest: external.documentDigest,
      externalIdDigest: external.externalIdDigest,
    };
  }
  throw invalidProvenance(path);
}

function parseNativeRef(value: unknown, path: string): NativeTurnRef {
  const object = exactObject(value, ['kind', 'backend', 'sessionId', 'nativeIds']);
  if (!object || object.kind !== 'native' || !nonEmptyString(object.backend) ||
    !nonEmptyString(object.sessionId) || !isSafeSessionId(object.sessionId)) {
    throw invalidProvenance(path);
  }
  return {
    kind: 'native',
    backend: object.backend,
    sessionId: object.sessionId,
    nativeIds: parseNativeIds(object.nativeIds, path),
  };
}

function parseNativeIds(value: unknown, path: string): NativeTurnIds {
  const object = exactObject(value, ['userId', 'assistantIds', 'completionId']);
  if (!object || !nonEmptyString(object.userId) || !nonEmptyString(object.completionId) ||
    !Array.isArray(object.assistantIds) || object.assistantIds.length === 0 ||
    !object.assistantIds.every(nonEmptyString)) {
    throw invalidProvenance(path);
  }
  const ids: NativeTurnIds = {
    userId: object.userId,
    assistantIds: object.assistantIds as string[],
    completionId: object.completionId,
  };
  if (new Set(ids.assistantIds).size !== ids.assistantIds.length ||
    ids.assistantIds.includes(ids.userId) || ids.completionId === ids.userId) {
    throw invalidProvenance(path);
  }
  return ids;
}

function exactObject(value: unknown, keys: readonly string[]): JsonObject | null {
  const object = asObject(value);
  if (!object) return null;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? object
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function invalidProvenance(path: string): OpenPError {
  return new OpenPError(`invalid seed provenance: ${path}`, EXIT_CODES.sessionState);
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError(`invalid session id for seed provenance: ${sessionId}`, EXIT_CODES.sessionState);
  }
}

function backendKey(backend: string): string {
  return createHash('sha256').update('openp.seed.provenance.backend.v1').update('\0').update(backend).digest('hex').slice(0, 24);
}

function digestExternalId(documentDigest: string, externalId: string): string {
  return createHash('sha256')
    .update('openp.seed.provenance.external-id.v1')
    .update('\0')
    .update(JSON.stringify({ documentDigest, externalId }))
    .digest('hex');
}
