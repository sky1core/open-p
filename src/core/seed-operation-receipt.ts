import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { NativeSessionReadResult, NativeTurnIds } from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import { ensureDurableDirectory, syncDirectory } from './fs-durability.js';
import {
  assertSeedAppendNativeIds,
  canonicalJson,
  cloneNativeTurnIds,
} from './seed-append-journal-schema.js';
import type { LogicalSeedTurn } from './seed-ir.js';
import { contentDigest } from './seed-ir.js';
import type { SeedProvenanceSource } from './seed-provenance.js';
import { isSafeSessionId } from './session-id.js';
import { SessionLockStore, type SessionLock } from './session-lock.js';
import { resolveOpenPStateRoot } from './state-root.js';
import { isCanonicalUuidV4 } from './uuid.js';
import type { SeedCliOptions } from './seed-args.js';
import type { ResolvedSeedSource, SeedResult, SeedResultSource } from './seed.js';

export type SeedOperationPhase = 'prepared' | 'creating' | 'target-created' | 'succeeded' | 'indeterminate';

export interface SeedOperationRequest {
  readonly targetBackend: string;
  readonly source: SeedOperationRequestSource;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly timeoutMs: number;
  readonly cwd: string;
}

export type SeedOperationRequestSource =
  | { readonly kind: 'native'; readonly backend: string; readonly sessionId: string }
  | { readonly kind: 'external-ir'; readonly documentDigest: string };

export interface SeedOperationSourceSnapshot {
  readonly output: SeedResultSource;
  readonly turnCount: number;
  readonly turnDigest: string;
}

export interface SeedOperationNativeFingerprint {
  readonly contentDigest: string;
  readonly nativeIds: NativeTurnIds;
}

export interface SeedOperationTargetEvidence {
  readonly backend: string;
  readonly sessionId: string;
  readonly bootstrap: readonly SeedOperationNativeFingerprint[];
  readonly nativeStateDigest: string;
  readonly provenanceDigest: string;
}

export interface SeedOperationBinding {
  readonly schemaVersion: 1;
  readonly operationDomainDigest: string;
  readonly source:
    | { readonly kind: 'native'; readonly storageIdentityDigest: string }
    | { readonly kind: 'external-ir' };
  readonly target: { readonly storageIdentityDigest: string };
}

interface SeedOperationReceiptBase {
  readonly operationId: string;
  readonly phase: SeedOperationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly request: SeedOperationRequest;
  readonly source: SeedOperationSourceSnapshot;
  readonly target?: SeedOperationTargetEvidence;
  readonly result?: SeedResult;
  readonly indeterminateReason?: 'creating-owner-ended-before-target-id';
}

export interface SeedOperationReceiptV1 extends SeedOperationReceiptBase {
  readonly schemaVersion: 1;
}

export interface SeedOperationReceiptV2 extends SeedOperationReceiptBase {
  readonly schemaVersion: 2;
  readonly binding: SeedOperationBinding;
}

export type SeedOperationReceipt = SeedOperationReceiptV1 | SeedOperationReceiptV2;

interface JsonObject {
  readonly [key: string]: unknown;
}

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_LOAD_RACE_RETRIES = 3;

class ReceiptChangedWhileReadingError extends Error {}

export class SeedOperationLockStore {
  private readonly lockStore: SessionLockStore;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.lockStore = new SessionLockStore(projectRoot, stateRoot, 'seed-operation-locks');
  }

  pathForOperation(operationId: string): string {
    assertOperationId(operationId);
    return this.lockStore.pathForSession(operationId);
  }

  acquire(operationId: string): Promise<SessionLock> {
    assertOperationId(operationId);
    return this.lockStore.acquire(operationId);
  }
}

export class SeedOperationReceiptStore {
  private readonly stateRoot: string;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.stateRoot = stateRoot;
  }

  pathForOperation(operationId: string): string {
    assertOperationId(operationId);
    return join(this.stateRoot, 'seed-operations', `${operationId}.json`);
  }

  async load(operationId: string): Promise<SeedOperationReceipt | null> {
    for (let attempt = 0; attempt <= MAX_LOAD_RACE_RETRIES; attempt += 1) {
      try {
        return await this.loadOnce(operationId);
      } catch (error) {
        if (!(error instanceof ReceiptChangedWhileReadingError)) throw error;
        if (attempt === MAX_LOAD_RACE_RETRIES) {
          throw stateError(`seed operation receipt kept changing while being read: ${this.pathForOperation(operationId)}`);
        }
      }
    }
    throw stateError(`failed to read seed operation receipt: ${this.pathForOperation(operationId)}`);
  }

  private async loadOnce(operationId: string): Promise<SeedOperationReceipt | null> {
    const path = this.pathForOperation(operationId);
    const directory = dirname(path);
    if (!(await inspectPrivateDirectory(directory, true))) {
      return null;
    }
    let stat = null;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw stateError(`failed to read seed operation receipt: ${path}`);
    }
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || !ownedByCurrentUser(stat.uid)) {
      throw stateError(`invalid seed operation receipt permissions: ${path}`);
    }
    const file = await openNoFollow(path);
    let primaryError: unknown = null;
    try {
      const fileStat = await file.stat();
      if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600 || !ownedByCurrentUser(fileStat.uid)) {
        throw stateError(`invalid seed operation receipt permissions: ${path}`);
      }
      if (fileStat.dev !== stat.dev || fileStat.ino !== stat.ino) {
        throw new ReceiptChangedWhileReadingError();
      }
      const bytes = await readBoundedReceipt(file, path, fileStat.size);
      if (!isUtf8(bytes)) {
        throw stateError(`invalid seed operation receipt: ${path}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw stateError(`invalid seed operation receipt: ${path}`);
      }
      const receipt = parseSeedOperationReceipt(parsed, path);
      if (receipt.operationId !== operationId) {
        throw stateError(`seed operation receipt belongs to a different operation: ${path}`);
      }
      await file.sync();
      const currentStat = await lstat(path);
      if (!currentStat.isFile() || currentStat.dev !== fileStat.dev || currentStat.ino !== fileStat.ino ||
        (currentStat.mode & 0o777) !== 0o600 || !ownedByCurrentUser(currentStat.uid)) {
        throw new ReceiptChangedWhileReadingError();
      }
      await syncDirectory(directory);
      return receipt;
    } catch (error) {
      primaryError = error;
      if (error instanceof ReceiptChangedWhileReadingError) throw error;
      if (error instanceof OpenPError) throw error;
      throw stateError(`failed to read seed operation receipt: ${path}`);
    } finally {
      try {
        await file.close();
      } catch {
        if (primaryError === null) {
          throw stateError(`failed to close seed operation receipt: ${path}`);
        }
      }
    }
  }

  async create(receipt: SeedOperationReceiptV2): Promise<void> {
    const checked = parseSeedOperationReceipt(receipt, 'seed operation receipt input');
    if (checked.schemaVersion !== 2) {
      throw stateError('new seed operation receipt must use schema version 2');
    }
    const serialized = serializeReceipt(checked, 'seed operation receipt input');
    const path = this.pathForOperation(checked.operationId);
    const directory = dirname(path);
    const tempPath = join(directory, `.seed-operation-${randomUUID()}.tmp`);
    let finalLinked = false;
    try {
      await ensureReceiptDirectory(directory);
      await writeReceiptTempFile(tempPath, serialized);
      await link(tempPath, path);
      finalLinked = true;
      await unlink(tempPath);
      await syncDirectory(directory);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (error instanceof OpenPError) throw error;
      if (isErrorCode(error, 'EEXIST')) {
        throw stateError(`seed operation receipt already exists: ${path}`);
      }
      throw stateError(`failed to write seed operation receipt: ${path}`, { receiptPresent: finalLinked });
    }
  }

  async update(expected: SeedOperationReceipt, next: SeedOperationReceipt): Promise<void> {
    const checkedExpected = parseSeedOperationReceipt(expected, 'seed operation receipt expected input');
    const checkedNext = parseSeedOperationReceipt(next, 'seed operation receipt update input');
    const serialized = serializeReceipt(checkedNext, 'seed operation receipt update input');
    if (checkedExpected.schemaVersion !== checkedNext.schemaVersion ||
      checkedExpected.operationId !== checkedNext.operationId ||
      checkedExpected.createdAt !== checkedNext.createdAt) {
      throw stateError('seed operation receipt update changes immutable identity');
    }
    if (canonicalJson(checkedExpected.request) !== canonicalJson(checkedNext.request) ||
      canonicalJson(checkedExpected.source) !== canonicalJson(checkedNext.source) ||
      (checkedExpected.schemaVersion === 2 && checkedNext.schemaVersion === 2 &&
        canonicalJson(checkedExpected.binding) !== canonicalJson(checkedNext.binding)) ||
      (checkedExpected.target !== undefined &&
        canonicalJson(checkedExpected.target) !== canonicalJson(checkedNext.target))) {
      throw stateError('seed operation receipt update changes immutable evidence');
    }
    if (Date.parse(checkedNext.updatedAt) < Date.parse(checkedExpected.updatedAt)) {
      throw stateError('seed operation receipt update moves its timestamp backwards');
    }
    if (!isAllowedTransition(checkedExpected.phase, checkedNext.phase)) {
      throw stateError(`invalid seed operation phase transition: ${checkedExpected.phase} -> ${checkedNext.phase}`);
    }
    const current = await this.load(checkedExpected.operationId);
    if (!current || canonicalJson(current) !== canonicalJson(checkedExpected)) {
      throw stateError('seed operation receipt changed before update');
    }
    const path = this.pathForOperation(checkedNext.operationId);
    const directory = dirname(path);
    const tempPath = join(directory, `.seed-operation-${randomUUID()}.tmp`);
    try {
      await ensureReceiptDirectory(directory);
      await writeReceiptTempFile(tempPath, serialized);
      await rename(tempPath, path);
      await syncDirectory(directory);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (error instanceof OpenPError) throw error;
      throw stateError(`failed to update seed operation receipt: ${path}`);
    }
  }
}

export function createPreparedSeedOperationReceipt(input: {
  readonly operationId: string;
  readonly request: SeedOperationRequest;
  readonly source: SeedOperationSourceSnapshot;
  readonly binding: SeedOperationBinding;
}): SeedOperationReceiptV2 {
  const now = new Date().toISOString();
  const receipt = parseSeedOperationReceipt({
    schemaVersion: 2,
    operationId: input.operationId,
    phase: 'prepared',
    createdAt: now,
    updatedAt: now,
    binding: input.binding,
    request: input.request,
    source: input.source,
  }, 'seed operation receipt input');
  if (receipt.schemaVersion !== 2) {
    throw stateError('new seed operation receipt must use schema version 2');
  }
  return receipt;
}

export function nextSeedOperationPhase(
  receipt: SeedOperationReceiptV2,
  phase: Exclude<SeedOperationPhase, 'prepared'>,
  extra?: {
    readonly target?: SeedOperationTargetEvidence;
    readonly result?: SeedResult;
    readonly indeterminateReason?: 'creating-owner-ended-before-target-id';
  },
): SeedOperationReceiptV2;
export function nextSeedOperationPhase(
  receipt: SeedOperationReceiptV1,
  phase: Exclude<SeedOperationPhase, 'prepared'>,
  extra?: {
    readonly target?: SeedOperationTargetEvidence;
    readonly result?: SeedResult;
    readonly indeterminateReason?: 'creating-owner-ended-before-target-id';
  },
): SeedOperationReceiptV1;
export function nextSeedOperationPhase(
  receipt: SeedOperationReceipt,
  phase: Exclude<SeedOperationPhase, 'prepared'>,
  extra: {
    readonly target?: SeedOperationTargetEvidence;
    readonly result?: SeedResult;
    readonly indeterminateReason?: 'creating-owner-ended-before-target-id';
  } = {},
): SeedOperationReceipt {
  const next = parseSeedOperationReceipt({
    schemaVersion: receipt.schemaVersion,
    operationId: receipt.operationId,
    phase,
    createdAt: receipt.createdAt,
    updatedAt: new Date().toISOString(),
    ...(receipt.schemaVersion === 2 ? { binding: receipt.binding } : {}),
    request: receipt.request,
    source: receipt.source,
    ...(extra.target ? { target: extra.target } : receipt.target ? { target: receipt.target } : {}),
    ...(extra.result ? { result: extra.result } : {}),
    ...(extra.indeterminateReason ? { indeterminateReason: extra.indeterminateReason } : {}),
  }, 'seed operation receipt update input');
  if (next.schemaVersion !== receipt.schemaVersion) {
    throw stateError('seed operation receipt update changes schema version');
  }
  return next;
}

export function seedOperationRequestFromSource(
  options: SeedCliOptions,
  cwd: string,
  source: ResolvedSeedSource,
): SeedOperationRequest {
  return {
    targetBackend: options.backend,
    source: source.output.kind === 'native'
      ? { kind: 'native', backend: source.output.backend, sessionId: source.output.sessionId }
      : { kind: 'external-ir', documentDigest: source.output.documentDigest },
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs,
    cwd,
  };
}

export function seedOperationRequestMatchesOptions(
  request: SeedOperationRequest,
  options: SeedCliOptions,
  cwd: string,
): boolean {
  if (request.targetBackend !== options.backend || request.cwd !== cwd ||
    request.model !== options.model || request.reasoningEffort !== options.reasoningEffort ||
    request.timeoutMs !== options.timeoutMs) {
    return false;
  }
  if (request.source.kind === 'native') {
    return options.source.kind === 'native' &&
      request.source.backend === options.source.backend &&
      request.source.sessionId === options.source.sessionId;
  }
  return options.source.kind === 'external-ir';
}

export function assertSeedOperationRequest(
  receipt: SeedOperationReceipt,
  request: SeedOperationRequest,
): void {
  if (canonicalJson(receipt.request) !== canonicalJson(request)) {
    throw conflictError('seed operation id conflicts with a different semantic request');
  }
}

export function assertSeedOperationBinding(
  receipt: SeedOperationReceiptV2,
  binding: SeedOperationBinding,
): void {
  if (canonicalJson(receipt.binding) !== canonicalJson(binding)) {
    throw conflictError('seed operation id conflicts with a different execution identity');
  }
}

export function createSeedOperationSourceSnapshot(source: ResolvedSeedSource): SeedOperationSourceSnapshot {
  return {
    output: source.output,
    turnCount: source.turns.length,
    turnDigest: digestSourcePrefix(source.turns, source.refs, source.turns.length),
  };
}

export function assertSeedOperationSourcePrefix(
  receipt: SeedOperationReceipt,
  source: ResolvedSeedSource,
): ResolvedSeedSource {
  if (!sameSeedResultSource(receipt.source.output, source.output)) {
    throw conflictError('seed operation source identity changed');
  }
  if (source.turns.length < receipt.source.turnCount || source.refs.length < receipt.source.turnCount) {
    throw conflictError('seed operation source no longer contains the recorded prefix');
  }
  const turnDigest = digestSourcePrefix(source.turns, source.refs, receipt.source.turnCount);
  if (turnDigest !== receipt.source.turnDigest) {
    throw conflictError('seed operation source prefix changed');
  }
  return {
    output: source.output,
    turns: source.turns.slice(0, receipt.source.turnCount),
    refs: source.refs.slice(0, receipt.source.turnCount),
  };
}

export function createSeedOperationTargetEvidence(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly bootstrapRead: NativeSessionReadResult;
  readonly provenanceDigest: string;
}): SeedOperationTargetEvidence {
  if (input.bootstrapRead.backend !== input.backend || input.bootstrapRead.sessionId !== input.sessionId ||
    !isSha256(input.bootstrapRead.nativeStateDigest)) {
    throw new OpenPError('seed operation target evidence has invalid native identity', EXIT_CODES.protocolViolation);
  }
  return parseTargetEvidence({
    backend: input.backend,
    sessionId: input.sessionId,
    bootstrap: input.bootstrapRead.turns.map((turn) => ({
      contentDigest: contentDigest(turn.userText, turn.assistantText),
      nativeIds: cloneNativeTurnIds(turn.nativeIds),
    })),
    nativeStateDigest: input.bootstrapRead.nativeStateDigest,
    provenanceDigest: input.provenanceDigest,
  }, 'seed operation target evidence input');
}

export function formatSeedOperationStatus(receipt: SeedOperationReceipt): string {
  return `${JSON.stringify({ seedOperation: toPublicSeedOperation(receipt) })}\n`;
}

export function toPublicSeedOperation(receipt: SeedOperationReceipt): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    identityEvidence: receipt.schemaVersion === 2 ? 'recorded' : 'legacy-unbound',
    operationId: receipt.operationId,
    phase: receipt.phase,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    request: receipt.request,
    source: receipt.source,
    ...(receipt.target ? { target: receipt.target } : {}),
    ...(receipt.result ? { seed: receipt.result } : {}),
    ...(receipt.indeterminateReason ? { indeterminateReason: receipt.indeterminateReason } : {}),
  };
}

function parseSeedOperationReceipt(value: unknown, path: string): SeedOperationReceipt {
  const version = asObject(value)?.schemaVersion;
  if (version !== 1 && version !== 2) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  const object = exactObject(value, [
    'schemaVersion',
    'operationId',
    'phase',
    'createdAt',
    'updatedAt',
    'request',
    'source',
    ...(version === 2 ? ['binding'] : []),
    ...optionalKeys(value, ['target', 'result', 'indeterminateReason']),
  ]);
  if (!object || object.schemaVersion !== version || !isCanonicalUuidV4(object.operationId) ||
    !isSeedOperationPhase(object.phase) || !validDate(object.createdAt) ||
    !validDate(object.updatedAt)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  const common = {
    operationId: object.operationId,
    phase: object.phase,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    request: parseRequest(object.request, path),
    source: parseSourceSnapshot(object.source, path),
    ...(object.target !== undefined ? { target: parseTargetEvidence(object.target, path) } : {}),
    ...(object.result !== undefined ? { result: parseSeedResult(object.result, path) } : {}),
    ...(object.indeterminateReason !== undefined
      ? { indeterminateReason: parseIndeterminateReason(object.indeterminateReason, path) }
      : {}),
  };
  const receipt: SeedOperationReceipt = version === 1
    ? { schemaVersion: 1, ...common }
    : { schemaVersion: 2, binding: parseBinding(object.binding, path), ...common };
  assertPhaseInvariant(receipt, path);
  return receipt;
}

function parseBinding(value: unknown, path: string): SeedOperationBinding {
  const object = exactObject(value, ['schemaVersion', 'operationDomainDigest', 'source', 'target']);
  const sourceObject = asObject(object?.source);
  const source = sourceObject?.kind === 'native'
    ? exactObject(object?.source, ['kind', 'storageIdentityDigest'])
    : sourceObject?.kind === 'external-ir'
      ? exactObject(object?.source, ['kind'])
      : null;
  const target = exactObject(object?.target, ['storageIdentityDigest']);
  if (!object || object.schemaVersion !== 1 || !isSha256(object.operationDomainDigest) ||
    !source || !target || !isSha256(target.storageIdentityDigest) ||
    (source.kind === 'native' && !isSha256(source.storageIdentityDigest))) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  return {
    schemaVersion: 1,
    operationDomainDigest: object.operationDomainDigest as string,
    source: source.kind === 'native'
      ? { kind: 'native', storageIdentityDigest: source.storageIdentityDigest as string }
      : { kind: 'external-ir' },
    target: { storageIdentityDigest: target.storageIdentityDigest as string },
  };
}

function parseRequest(value: unknown, path: string): SeedOperationRequest {
  const object = exactObject(value, ['targetBackend', 'source', 'model', 'reasoningEffort', 'timeoutMs', 'cwd']);
  if (!object || !nonEmptyString(object.targetBackend) || !nullableNonEmptyString(object.model) ||
    !nullableNonEmptyString(object.reasoningEffort) || !Number.isSafeInteger(object.timeoutMs) ||
    (object.timeoutMs as number) < 0 || !nonEmptyString(object.cwd)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  return {
    targetBackend: object.targetBackend,
    source: parseRequestSource(object.source, path),
    model: object.model,
    reasoningEffort: object.reasoningEffort,
    timeoutMs: object.timeoutMs as number,
    cwd: object.cwd,
  };
}

function parseRequestSource(value: unknown, path: string): SeedOperationRequestSource {
  const object = asObject(value);
  if (object?.kind === 'native') {
    const native = exactObject(value, ['kind', 'backend', 'sessionId']);
    if (!native || !nonEmptyString(native.backend) || !nonEmptyString(native.sessionId) ||
      !isSafeSessionId(native.sessionId)) {
      throw stateError(`invalid seed operation receipt: ${path}`);
    }
    return { kind: 'native', backend: native.backend, sessionId: native.sessionId };
  }
  if (object?.kind === 'external-ir') {
    const external = exactObject(value, ['kind', 'documentDigest']);
    if (!external || !isSha256(external.documentDigest)) {
      throw stateError(`invalid seed operation receipt: ${path}`);
    }
    return { kind: 'external-ir', documentDigest: external.documentDigest as string };
  }
  throw stateError(`invalid seed operation receipt: ${path}`);
}

function parseSourceSnapshot(value: unknown, path: string): SeedOperationSourceSnapshot {
  const object = exactObject(value, ['output', 'turnCount', 'turnDigest']);
  if (!object || !Number.isSafeInteger(object.turnCount) || (object.turnCount as number) <= 0 ||
    !isSha256(object.turnDigest)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  return {
    output: parseSeedResultSource(object.output, path),
    turnCount: object.turnCount as number,
    turnDigest: object.turnDigest as string,
  };
}

function parseTargetEvidence(value: unknown, path: string): SeedOperationTargetEvidence {
  const object = exactObject(value, ['backend', 'sessionId', 'bootstrap', 'nativeStateDigest', 'provenanceDigest']);
  if (!object || !nonEmptyString(object.backend) || !nonEmptyString(object.sessionId) ||
    !isSafeSessionId(object.sessionId) || !Array.isArray(object.bootstrap) ||
    object.bootstrap.length !== 1 || !isSha256(object.nativeStateDigest) ||
    !isSha256(object.provenanceDigest)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  return {
    backend: object.backend,
    sessionId: object.sessionId,
    bootstrap: object.bootstrap.map((item) => parseNativeFingerprint(item, path)),
    nativeStateDigest: object.nativeStateDigest as string,
    provenanceDigest: object.provenanceDigest as string,
  };
}

function parseNativeFingerprint(value: unknown, path: string): SeedOperationNativeFingerprint {
  const object = exactObject(value, ['contentDigest', 'nativeIds']);
  if (!object || !isSha256(object.contentDigest)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  return {
    contentDigest: object.contentDigest as string,
    nativeIds: parseNativeIds(object.nativeIds, path),
  };
}

function parseSeedResult(value: unknown, path: string): SeedResult {
  const object = exactObject(value, ['source', 'target', 'appendedTurns', 'mode', 'status']);
  const target = exactObject(object?.target, ['backend', 'sessionId']);
  if (!object || !target || !Number.isSafeInteger(object.appendedTurns) ||
    (object.appendedTurns as number) < 0 || object.mode !== 'create' ||
    object.status !== 'created' || !nonEmptyString(target.backend) ||
    !nonEmptyString(target.sessionId) || !isSafeSessionId(target.sessionId)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  return {
    source: parseSeedResultSource(object.source, path),
    target: { backend: target.backend, sessionId: target.sessionId },
    appendedTurns: object.appendedTurns as number,
    mode: 'create',
    status: 'created',
  };
}

function parseSeedResultSource(value: unknown, path: string): SeedResultSource {
  const object = asObject(value);
  if (object?.kind === 'native') {
    const native = exactObject(value, ['kind', 'backend', 'sessionId']);
    if (!native || !nonEmptyString(native.backend) || !nonEmptyString(native.sessionId) ||
      !isSafeSessionId(native.sessionId)) {
      throw stateError(`invalid seed operation receipt: ${path}`);
    }
    return { kind: 'native', backend: native.backend, sessionId: native.sessionId };
  }
  if (object?.kind === 'external-ir') {
    const external = exactObject(value, ['kind', 'documentDigest']);
    if (!external || !isSha256(external.documentDigest)) {
      throw stateError(`invalid seed operation receipt: ${path}`);
    }
    return { kind: 'external-ir', documentDigest: external.documentDigest as string };
  }
  throw stateError(`invalid seed operation receipt: ${path}`);
}

function parseNativeIds(value: unknown, path: string): NativeTurnIds {
  const object = exactObject(value, ['userId', 'assistantIds', 'completionId']);
  if (!object || !nonEmptyString(object.userId) || !nonEmptyString(object.completionId) ||
    !Array.isArray(object.assistantIds) || object.assistantIds.length === 0 ||
    !object.assistantIds.every(nonEmptyString)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  const ids = {
    userId: object.userId,
    assistantIds: object.assistantIds as string[],
    completionId: object.completionId,
  };
  assertSeedAppendNativeIds(ids, 'seed operation receipt', EXIT_CODES.sessionState);
  return ids;
}

function parseIndeterminateReason(value: unknown, path: string): 'creating-owner-ended-before-target-id' {
  if (value !== 'creating-owner-ended-before-target-id') {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  return value;
}

function assertPhaseInvariant(receipt: SeedOperationReceipt, path: string): void {
  if (Date.parse(receipt.updatedAt) < Date.parse(receipt.createdAt)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (!requestSourceMatchesSnapshot(receipt.request.source, receipt.source.output)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (receipt.schemaVersion === 2 && receipt.binding.source.kind !== receipt.request.source.kind) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (receipt.target && receipt.target.backend !== receipt.request.targetBackend) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (receipt.result && !sameSeedResultSource(receipt.result.source, receipt.source.output)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (receipt.result && receipt.result.appendedTurns !== receipt.source.turnCount) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if ((receipt.phase === 'prepared' || receipt.phase === 'creating') &&
    (receipt.target !== undefined || receipt.result !== undefined || receipt.indeterminateReason !== undefined)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (receipt.phase === 'target-created' &&
    (receipt.target === undefined || receipt.result !== undefined || receipt.indeterminateReason !== undefined)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (receipt.phase === 'succeeded' &&
    (receipt.target === undefined || receipt.result === undefined || receipt.indeterminateReason !== undefined ||
      receipt.result.target.backend !== receipt.target.backend ||
      receipt.result.target.sessionId !== receipt.target.sessionId)) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
  if (receipt.phase === 'indeterminate' &&
    (receipt.target !== undefined || receipt.result !== undefined ||
      receipt.indeterminateReason !== 'creating-owner-ended-before-target-id')) {
    throw stateError(`invalid seed operation receipt: ${path}`);
  }
}

function isAllowedTransition(from: SeedOperationPhase, to: SeedOperationPhase): boolean {
  return (from === 'prepared' && to === 'creating') ||
    (from === 'creating' && (to === 'target-created' || to === 'indeterminate')) ||
    (from === 'target-created' && to === 'succeeded');
}

function digestSourcePrefix(
  turns: readonly LogicalSeedTurn[],
  refs: readonly SeedProvenanceSource[],
  count: number,
): string {
  if (turns.length < count || refs.length < count) {
    throw conflictError('seed operation source snapshot is shorter than expected');
  }
  return createHash('sha256')
    .update('openp.seed.operation.source-snapshot.v1')
    .update('\0')
    .update(canonicalJson({
      turns: turns.slice(0, count).map((turn, index) => ({
        logicalId: turn.logicalId,
        contentDigest: turn.contentDigest,
        source: refs[index],
      })),
    }))
    .digest('hex');
}

function sameSeedResultSource(a: SeedResultSource, b: SeedResultSource): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function requestSourceMatchesSnapshot(request: SeedOperationRequestSource, output: SeedResultSource): boolean {
  if (request.kind === 'native') {
    return output.kind === 'native' && request.backend === output.backend && request.sessionId === output.sessionId;
  }
  return output.kind === 'external-ir' && request.documentDigest === output.documentDigest;
}

async function ensureReceiptDirectory(directory: string): Promise<void> {
  try {
    if (await inspectPrivateDirectory(directory, true)) {
      return;
    }
    const parent = dirname(directory);
    await ensureReceiptParentDirectory(parent);
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }
    if (created) {
      await chmod(directory, 0o700);
    }
    await inspectPrivateDirectory(directory, false);
    await syncDirectory(directory);
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof OpenPError) throw error;
    throw stateError(`failed to create seed operation directory: ${directory}`);
  }
}

async function ensureReceiptParentDirectory(directory: string): Promise<void> {
  let exists = false;
  try {
    const stat = await lstat(directory);
    exists = true;
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || !ownedByCurrentUser(stat.uid)) {
      throw stateError(`invalid seed operation parent directory (must be an owned, non-group/other-writable directory): ${directory}`);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  if (!exists) {
    await ensureDurableDirectory(directory, 0o700, false);
  }
  await inspectOwnedDirectory(directory, false);
}

async function inspectPrivateDirectory(directory: string, allowMissing: boolean): Promise<boolean> {
  let observed;
  try {
    observed = await lstat(directory);
  } catch (error) {
    if (allowMissing && isNotFoundError(error)) return false;
    throw stateError(`failed to read seed operation directory: ${directory}`);
  }
  if (!observed.isDirectory() || (observed.mode & 0o777) !== 0o700 || !ownedByCurrentUser(observed.uid)) {
    throw stateError(`invalid seed operation directory permissions: ${directory}`);
  }
  let handle: FileHandle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  } catch {
    throw stateError(`invalid seed operation directory: ${directory}`);
  }
  let primaryError: unknown = null;
  try {
    const actual = await handle.stat();
    if (!actual.isDirectory() || actual.dev !== observed.dev || actual.ino !== observed.ino ||
      (actual.mode & 0o777) !== 0o700 || !ownedByCurrentUser(actual.uid)) {
      throw stateError(`seed operation directory changed while being read: ${directory}`);
    }
  } catch (error) {
    primaryError = error;
    if (error instanceof OpenPError) throw error;
    throw stateError(`failed to inspect seed operation directory: ${directory}`);
  } finally {
    try {
      await handle.close();
    } catch {
      if (primaryError === null) {
        throw stateError(`failed to close seed operation directory: ${directory}`);
      }
    }
  }
  return true;
}

async function inspectOwnedDirectory(directory: string, allowMissing: boolean): Promise<boolean> {
  let observed;
  try {
    observed = await lstat(directory);
  } catch (error) {
    if (allowMissing && isNotFoundError(error)) return false;
    throw stateError(`failed to read seed operation parent directory: ${directory}`);
  }
  if (!observed.isDirectory() || (observed.mode & 0o022) !== 0 || !ownedByCurrentUser(observed.uid)) {
    throw stateError(`invalid seed operation parent directory (must be an owned, non-group/other-writable directory): ${directory}`);
  }
  let handle: FileHandle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  } catch {
    throw stateError(`invalid seed operation parent directory: ${directory}`);
  }
  let primaryError: unknown = null;
  try {
    const actual = await handle.stat();
    if (!actual.isDirectory() || actual.dev !== observed.dev || actual.ino !== observed.ino ||
      (actual.mode & 0o022) !== 0 || !ownedByCurrentUser(actual.uid)) {
      throw stateError(`seed operation parent directory changed while being read: ${directory}`);
    }
  } catch (error) {
    primaryError = error;
    if (error instanceof OpenPError) throw error;
    throw stateError(`failed to inspect seed operation parent directory: ${directory}`);
  } finally {
    try {
      await handle.close();
    } catch {
      if (primaryError === null) {
        throw stateError(`failed to close seed operation parent directory: ${directory}`);
      }
    }
  }
  return true;
}

async function readBoundedReceipt(file: FileHandle, path: string, knownSize: number): Promise<Buffer> {
  if (knownSize > MAX_RECEIPT_BYTES) {
    throw stateError(`seed operation receipt exceeds ${MAX_RECEIPT_BYTES} bytes: ${path}`);
  }
  const buffer = Buffer.allocUnsafe(MAX_RECEIPT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_RECEIPT_BYTES) {
    throw stateError(`seed operation receipt exceeds ${MAX_RECEIPT_BYTES} bytes: ${path}`);
  }
  return buffer.subarray(0, offset);
}

async function writeReceiptTempFile(path: string, serialized: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  let primaryError: unknown = null;
  try {
    await file.writeFile(serialized, 'utf8');
    await file.chmod(0o600);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || !ownedByCurrentUser(stat.uid)) {
      throw stateError(`invalid seed operation temporary receipt permissions: ${path}`);
    }
    await file.sync();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await file.close();
    } catch {
      if (primaryError === null) {
        throw stateError(`failed to close seed operation temporary receipt: ${path}`);
      }
    }
  }
}

function serializeReceipt(receipt: SeedOperationReceipt, source: string): string {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECEIPT_BYTES) {
    throw stateError(`seed operation receipt exceeds ${MAX_RECEIPT_BYTES} bytes: ${source}`);
  }
  return serialized;
}

async function openNoFollow(path: string) {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrorCode(error, 'ELOOP')) {
      throw stateError(`invalid seed operation receipt symlink: ${path}`);
    }
    throw stateError(`failed to open seed operation receipt: ${path}`);
  }
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

function optionalKeys(value: unknown, keys: readonly string[]): string[] {
  const object = asObject(value);
  return object ? keys.filter((key) => Object.prototype.hasOwnProperty.call(object, key)) : [];
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function isSeedOperationPhase(value: unknown): value is SeedOperationPhase {
  return value === 'prepared' || value === 'creating' || value === 'target-created' ||
    value === 'succeeded' || value === 'indeterminate';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value);
}

function isSha256(value: unknown): value is string {
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

function ownedByCurrentUser(uid: number): boolean {
  const current = process.getuid?.();
  return current === undefined || uid === current;
}

function assertOperationId(operationId: string): void {
  if (!isCanonicalUuidV4(operationId)) {
    throw stateError(`invalid seed operation id: ${operationId}`);
  }
}

function stateError(message: string, details?: Readonly<Record<string, unknown>>): OpenPError {
  return new OpenPError(message, EXIT_CODES.sessionState, { details });
}

function conflictError(message: string): OpenPError {
  return new OpenPError(message, EXIT_CODES.sessionState, { details: { conflict: true } });
}

function isNotFoundError(error: unknown): boolean {
  return isErrorCode(error, 'ENOENT');
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { readonly code?: unknown }).code === code;
}
