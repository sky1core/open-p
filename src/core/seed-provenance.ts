import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeSessionReadResult, NativeTurnIds, NativeWrittenTurn } from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import {
  contentDigest,
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
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new OpenPError(`failed to read seed provenance: ${path}`, EXIT_CODES.sessionState);
    }
    try {
      return parseState(JSON.parse(text), path);
    } catch (error) {
      if (error instanceof OpenPError) {
        throw error;
      }
      throw new OpenPError(`failed to parse seed provenance: ${path}`, EXIT_CODES.sessionState);
    }
  }

  async save(state: SeedProvenanceState): Promise<void> {
    assertSafeSessionId(state.sessionId);
    await mkdir(join(this.stateRoot, 'seed-provenance'), { recursive: true, mode: 0o700 });
    const path = this.pathForSession(state.backend, state.sessionId);
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(tempPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tempPath, path);
      await chmod(path, 0o600).catch(() => undefined);
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
  return {
    ...base,
    updatedAt: now,
    bootstrap: input.bootstrap ?? base.bootstrap,
    entries: [...base.entries, ...additions],
  };
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
  assertAllTargetMappingsPresent(read, provenance);
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
  return result;
}

function assertAllTargetMappingsPresent(
  read: NativeSessionReadResult,
  provenance: SeedProvenanceState,
): void {
  for (const entry of provenance.entries) {
    const target = entry.target;
    if (target.backend !== read.backend || target.sessionId !== read.sessionId) {
      throw new OpenPError('seed provenance target belongs to a different native session', EXIT_CODES.protocolViolation);
    }
    if (!read.turns.some((turn) => sameNativeIds(target.nativeIds, turn.nativeIds))) {
      throw new OpenPError('seed provenance target mapping is missing from the native session', EXIT_CODES.protocolViolation);
    }
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
    if (sourceIds[index] !== targetIds[index]) {
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
    const refs = [entry.target, entry.source].filter((ref): ref is NativeTurnRef => ref.kind === 'native');
    for (const ref of refs) {
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
  if (a.userId === b.userId || a.completionId === b.completionId) {
    return true;
  }
  const assistantIds = new Set(a.assistantIds);
  return b.assistantIds.some((id) => assistantIds.has(id));
}

function parseState(value: unknown, path: string): SeedProvenanceState {
  const object = asObject(value);
  if (!object || object.schemaVersion !== 1 || typeof object.backend !== 'string' ||
    typeof object.sessionId !== 'string' || typeof object.createdAt !== 'string' ||
    typeof object.updatedAt !== 'string' || !Array.isArray(object.bootstrap) ||
    !Array.isArray(object.entries)) {
    throw new OpenPError(`invalid seed provenance: ${path}`, EXIT_CODES.sessionState);
  }
  return {
    schemaVersion: 1,
    backend: object.backend,
    sessionId: object.sessionId,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    bootstrap: object.bootstrap.map((ids) => parseNativeIds(ids, path)),
    entries: object.entries.map((entry) => parseEntry(entry, path)),
  };
}

function parseEntry(value: unknown, path: string): SeedProvenanceEntry {
  const object = asObject(value);
  if (!object || typeof object.logicalId !== 'string' || typeof object.contentDigest !== 'string') {
    throw new OpenPError(`invalid seed provenance: ${path}`, EXIT_CODES.sessionState);
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
    throw new OpenPError(`invalid seed provenance: ${path}`, EXIT_CODES.sessionState);
  }
  if (object.kind === 'native') {
    return parseNativeRef(object, path);
  }
  if (object.kind === 'external-ir' && typeof object.documentDigest === 'string' &&
    typeof object.externalIdDigest === 'string') {
    return {
      kind: 'external-ir',
      documentDigest: object.documentDigest,
      externalIdDigest: object.externalIdDigest,
    };
  }
  throw new OpenPError(`invalid seed provenance: ${path}`, EXIT_CODES.sessionState);
}

function parseNativeRef(value: unknown, path: string): NativeTurnRef {
  const object = asObject(value);
  if (!object || object.kind !== 'native' || typeof object.backend !== 'string' || typeof object.sessionId !== 'string') {
    throw new OpenPError(`invalid seed provenance: ${path}`, EXIT_CODES.sessionState);
  }
  return {
    kind: 'native',
    backend: object.backend,
    sessionId: object.sessionId,
    nativeIds: parseNativeIds(object.nativeIds, path),
  };
}

function parseNativeIds(value: unknown, path: string): NativeTurnIds {
  const object = asObject(value);
  if (!object || typeof object.userId !== 'string' || typeof object.completionId !== 'string' ||
    !Array.isArray(object.assistantIds) || !object.assistantIds.every((id) => typeof id === 'string')) {
    throw new OpenPError(`invalid seed provenance: ${path}`, EXIT_CODES.sessionState);
  }
  return {
    userId: object.userId,
    assistantIds: object.assistantIds,
    completionId: object.completionId,
  };
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
