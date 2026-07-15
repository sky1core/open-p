import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isAbortError, throwIfAborted } from './abort.js';
import type {
  CleanupPreparedSessionHistoryAppendInput,
  NativeSessionReadResult,
  NativeSessionTurn,
  NativeWrittenTurn,
  ReadNativeSessionInput,
} from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import { ensureDurableDirectory, syncDirectory } from './fs-durability.js';
import { contentDigest } from './seed-ir.js';
import {
  SeedProvenanceStore,
  withAppendedProvenanceEntries,
  type SeedProvenanceEntry,
  type SeedProvenanceSource,
  type SeedProvenanceState,
} from './seed-provenance.js';
import {
  assertSeedAppendNativeIds,
  canonicalJson,
  cloneNativeTurnIds,
  parseSeedAppendJournal,
  sameNativeTurnIds,
  sameSeedAppendJournal,
  uniqueNativeTurnIds,
  type SeedAppendJournal,
  type SeedAppendNativeFingerprint,
} from './seed-append-journal-schema.js';
import { isSafeSessionId } from './session-id.js';
import { SessionStateStore, type PendingSeedAppendSessionState } from './session-state.js';
import { resolveOpenPStateRoot } from './state-root.js';
import { isNativeStateDigest } from './native-state-digest.js';

export type {
  SeedAppendJournal,
  SeedAppendJournalTurn,
  SeedAppendNativeFingerprint,
} from './seed-append-journal-schema.js';

export class SeedAppendJournalStore {
  private readonly stateRoot: string;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.stateRoot = stateRoot;
  }

  pathForSession(backend: string, sessionId: string): string {
    assertSafeIdentity(backend, sessionId, 'pending seed journal');
    return join(this.stateRoot, 'seed-pending', `${backendKey(backend)}-${sessionId}.json`);
  }

  async load(backend: string, sessionId: string): Promise<SeedAppendJournal | null> {
    const path = this.pathForSession(backend, sessionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw stateError(`failed to read pending seed journal: ${path}`);
    }
    if (!isUtf8(bytes)) {
      throw stateError(`invalid pending seed journal: ${path}`);
    }
    const text = bytes.toString('utf8');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw stateError(`invalid pending seed journal: ${path}`);
    }
    const journal = parseSeedAppendJournal(value, path);
    if (journal.backend !== backend || journal.sessionId !== sessionId) {
      throw stateError(`pending seed journal belongs to a different session: ${path}`);
    }
    return journal;
  }

  async create(journal: SeedAppendJournal): Promise<void> {
    const checked = parseSeedAppendJournal(journal, 'pending seed journal input');
    const path = this.pathForSession(checked.backend, checked.sessionId);
    const directory = dirname(path);
    const tempPath = join(directory, `.seed-pending-${randomUUID()}.tmp`);
    let finalLinked = false;
    try {
      await ensureDurableDirectory(directory);
      const file = await open(tempPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(checked, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await link(tempPath, path);
      finalLinked = true;
      await unlink(tempPath);
      await syncDirectory(directory);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (error instanceof OpenPError) {
        throw error;
      }
      if (isErrorCode(error, 'EEXIST')) {
        throw stateError(`pending seed journal already exists: ${path}`);
      }
      // If link succeeded but a later durability operation failed, retain the final journal. The
      // caller must not mutate native state because this preparation promise rejects.
      throw stateError(`failed to write pending seed journal: ${path}`, {
        journalPresent: finalLinked,
      });
    }
  }

  async remove(backend: string, sessionId: string): Promise<void> {
    const path = this.pathForSession(backend, sessionId);
    const directory = dirname(path);
    try {
      await unlink(path);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw stateError(`failed to retire pending seed journal: ${path}`);
      }
    }
    try {
      // ENOENT can be the retry after unlink succeeded but the containing-directory fsync failed.
      // If the journal directory itself is absent (marker-only recovery), sync the state root so
      // that directory absence is durable before the v2 marker is restored to v1.
      await syncDirectory(directory);
    } catch (error) {
      if (isNotFoundError(error)) {
        try {
          await syncDirectory(dirname(directory));
          return;
        } catch (parentError) {
          // A state root that has never existed cannot contain a previously published journal.
          // Journal publication durably creates this hierarchy and no production path removes it.
          if (isNotFoundError(parentError)) {
            return;
          }
          throw stateError(`failed to retire pending seed journal: ${path}`);
        }
      }
      throw stateError(`failed to retire pending seed journal: ${path}`);
    }
  }
}

export function createSeedAppendJournal(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly before: NativeSessionReadResult;
  readonly provenance: SeedProvenanceState | null;
  readonly sourceRefs: readonly SeedProvenanceSource[];
  readonly written: readonly NativeWrittenTurn[];
  readonly candidateNativeStateDigest: string;
  readonly cleanupToken?: string | null;
}): SeedAppendJournal {
  if (input.sourceRefs.length !== input.written.length || input.written.length === 0) {
    throw new OpenPError('pending seed journal turn count mismatch', EXIT_CODES.protocolViolation);
  }
  if (!isNativeStateDigest(input.before.nativeStateDigest) ||
    !isNativeStateDigest(input.candidateNativeStateDigest) ||
    input.before.nativeStateDigest === input.candidateNativeStateDigest) {
    throw new OpenPError('pending seed journal native state digest is invalid', EXIT_CODES.protocolViolation);
  }
  const journal: SeedAppendJournal = {
    schemaVersion: 1,
    operationId: randomUUID(),
    cleanupToken: input.cleanupToken ?? null,
    backend: input.backend,
    sessionId: input.sessionId,
    createdAt: new Date().toISOString(),
    base: {
      native: fingerprintNativeTurns(input.before.turns),
      nativeStateDigest: input.before.nativeStateDigest,
      provenanceDigest: provenanceStructureDigest(input.provenance, input.backend, input.sessionId),
      provenanceEntryCount: input.provenance?.entries.length ?? 0,
    },
    candidateNativeStateDigest: input.candidateNativeStateDigest,
    planned: input.written.map((turn, index) => ({
      logicalId: turn.logicalId,
      contentDigest: turn.contentDigest,
      source: structuredClone(input.sourceRefs[index]!),
      nativeIds: cloneNativeTurnIds(turn.nativeIds),
    })),
  };
  return parseSeedAppendJournal(journal, 'pending seed journal input');
}

export type SeedAppendSettlementStatus = 'none' | 'not-committed' | 'committed' | 'already-settled';

// The caller must hold the canonical target session lock. This function never invokes a Writer or
// repeats a native append; it only classifies exact Reader/provenance state and settles metadata.
export async function settlePendingSeedAppend(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly readNativeSession: (input: ReadNativeSessionInput) => Promise<NativeSessionReadResult>;
  readonly cleanupPreparedAppend?: (input: CleanupPreparedSessionHistoryAppendInput) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly journalStore?: SeedAppendJournalStore;
  readonly provenanceStore?: SeedProvenanceStore;
  readonly sessionStateStore?: SessionStateStore;
}): Promise<SeedAppendSettlementStatus> {
  throwIfAborted(input.signal);
  const journalStore = input.journalStore ?? new SeedAppendJournalStore(input.cwd);
  const provenanceStore = input.provenanceStore ?? new SeedProvenanceStore(input.cwd);
  const sessionStateStore = input.sessionStateStore ?? new SessionStateStore(input.cwd);
  const marker = await sessionStateStore.loadPendingSeedAppendMarker(input.sessionId);
  const journal = await journalStore.load(input.backend, input.sessionId);
  if (marker && (marker.backend !== input.backend || marker.backendSessionId !== input.sessionId ||
    !sameSeedAppendJournal(marker.seedAppendJournal, journal ?? marker.seedAppendJournal))) {
    throw stateError('pending seed session marker does not match journal evidence');
  }
  if (!marker && !journal) {
    // `load()` seeing ENOENT can be the retry after unlink succeeded but the seed-pending directory
    // fsync failed. Re-run idempotent retirement so absence is durable before a new native turn.
    await journalStore.remove(input.backend, input.sessionId);
    await sessionStateStore.confirmCompatibleV1DurabilityIfPresent({
      backend: input.backend,
      backendSessionId: input.sessionId,
      cwd: input.cwd,
    });
    return 'none';
  }
  const evidence = marker?.seedAppendJournal ?? journal;
  if (!evidence) {
    return 'none';
  }
  if (evidence.cleanupToken !== null && !input.cleanupPreparedAppend) {
    throw new OpenPError(
      `backend ${input.backend} cannot clean its pending native append artifact`,
      EXIT_CODES.protocolViolation,
    );
  }

  const provenance = await provenanceStore.load(input.backend, input.sessionId);
  const provenanceStatus = classifyProvenanceForSettlement(provenance, evidence);
  let read: NativeSessionReadResult;
  try {
    read = await input.readNativeSession({
      sessionId: input.sessionId,
      cwd: input.cwd,
      mode: 'settlement',
      signal: input.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new OpenPError(
      `pending seed append cannot verify the native session: ${errorMessage(error)}`,
      EXIT_CODES.protocolViolation,
    );
  }
  assertNativeReadIdentityAndShape(read, input.backend, input.sessionId);

  const currentNative = fingerprintNativeTurns(read.turns);
  const expectedFull = [
    ...evidence.base.native,
    ...evidence.planned.map((turn) => ({
      contentDigest: turn.contentDigest,
      nativeIds: turn.nativeIds,
    })),
  ];
  const nativeIsBase = sameFingerprints(currentNative, evidence.base.native) &&
    read.nativeStateDigest === evidence.base.nativeStateDigest;
  const nativeIsFull = sameFingerprints(currentNative, expectedFull) &&
    read.nativeStateDigest === evidence.candidateNativeStateDigest;
  if (!nativeIsBase && !nativeIsFull) {
    throw divergenceError('pending seed append native state is partial, changed, reordered, or has an extra suffix');
  }

  if (nativeIsBase && provenanceStatus === 'base') {
    await cleanupPreparedArtifact(input, evidence);
    await retireSettlementEvidence({ marker, journal, journalStore, sessionStateStore, backend: input.backend, sessionId: input.sessionId });
    return 'not-committed';
  }
  if (nativeIsFull && provenanceStatus === 'base') {
    const next = withAppendedProvenanceEntries(provenance, {
      targetBackend: input.backend,
      targetSessionId: input.sessionId,
      sourceRefs: evidence.planned.map((turn) => turn.source),
      written: evidence.planned.map((turn) => ({
        logicalId: turn.logicalId,
        contentDigest: turn.contentDigest,
        nativeIds: turn.nativeIds,
      })),
    });
    await provenanceStore.save(next);
    await cleanupPreparedArtifact(input, evidence);
    await retireSettlementEvidence({ marker, journal, journalStore, sessionStateStore, backend: input.backend, sessionId: input.sessionId });
    return 'committed';
  }
  if (nativeIsFull && provenanceStatus === 'final') {
    // The visible final file may be the result of a prior rename whose containing-directory fsync
    // failed. Re-saving the exact parsed state re-establishes file+directory durability before
    // cleanup and pending-evidence retirement make that mapping the only recovery authority.
    if (!provenance) {
      throw divergenceError('pending seed append final provenance is missing');
    }
    await provenanceStore.save(provenance);
    await cleanupPreparedArtifact(input, evidence);
    await retireSettlementEvidence({ marker, journal, journalStore, sessionStateStore, backend: input.backend, sessionId: input.sessionId });
    return 'already-settled';
  }
  throw divergenceError('pending seed append provenance conflicts with the exact native state');
}

async function cleanupPreparedArtifact(
  input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly cleanupPreparedAppend?: (input: CleanupPreparedSessionHistoryAppendInput) => Promise<void>;
  },
  journal: SeedAppendJournal,
): Promise<void> {
  if (journal.cleanupToken === null) {
    return;
  }
  const cleanup = input.cleanupPreparedAppend;
  if (!cleanup) {
    throw new OpenPError('pending seed append cleanup capability is unavailable', EXIT_CODES.protocolViolation);
  }
  try {
    await cleanup({
      sessionId: input.sessionId,
      cwd: input.cwd,
      token: journal.cleanupToken,
      signal: input.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const exitCode = error instanceof OpenPError ? error.exitCode : EXIT_CODES.sessionState;
    throw new OpenPError(
      `pending seed append artifact cleanup failed: ${errorMessage(error)}`,
      exitCode,
      {
        reasonCode: error instanceof OpenPError ? error.reasonCode : undefined,
        details: {
          ...(error instanceof OpenPError ? error.details : undefined),
          cleanupFailed: true,
        },
      },
    );
  }
}

async function retireSettlementEvidence(input: {
  readonly marker: PendingSeedAppendSessionState | null;
  readonly journal: SeedAppendJournal | null;
  readonly journalStore: SeedAppendJournalStore;
  readonly sessionStateStore: SessionStateStore;
  readonly backend: string;
  readonly sessionId: string;
}): Promise<void> {
  if (input.marker || input.journal) {
    await input.journalStore.remove(input.backend, input.sessionId);
  }
  if (input.marker) {
    await input.sessionStateStore.restorePendingSeedAppendMarker(input.marker);
  }
}

type ProvenanceSettlementStatus = 'base' | 'final';

function classifyProvenanceForSettlement(
  provenance: SeedProvenanceState | null,
  journal: SeedAppendJournal,
): ProvenanceSettlementStatus {
  const basePrefixCount = findCurrentBasePrefixCount(provenance, journal);
  if (basePrefixCount !== null && basePrefixCount !== journal.base.provenanceEntryCount) {
    throw stateError('pending seed journal provenance count conflicts with its digest');
  }
  const entryCount = provenance?.entries.length ?? 0;
  if (entryCount === journal.base.provenanceEntryCount &&
    provenanceStructureDigest(provenance, journal.backend, journal.sessionId) === journal.base.provenanceDigest) {
    return 'base';
  }
  if (isFinalProvenance(provenance, journal)) {
    return 'final';
  }
  throw divergenceError('pending seed append provenance conflicts with the settlement journal');
}

function findCurrentBasePrefixCount(
  provenance: SeedProvenanceState | null,
  journal: SeedAppendJournal,
): number | null {
  const entries = provenance?.entries ?? [];
  for (let count = 0; count <= entries.length; count += 1) {
    const prefix: SeedProvenanceState | null = provenance
      ? { ...provenance, entries: entries.slice(0, count) }
      : null;
    if (provenanceStructureDigest(prefix, journal.backend, journal.sessionId) === journal.base.provenanceDigest) {
      return count;
    }
  }
  return null;
}

export function provenanceStructureDigest(
  provenance: SeedProvenanceState | null,
  backend: string,
  sessionId: string,
): string {
  if (provenance && (provenance.backend !== backend || provenance.sessionId !== sessionId)) {
    throw stateError('seed provenance belongs to a different session');
  }
  return createHash('sha256')
    .update('openp.seed.provenance.structure.v1')
    .update('\0')
    .update(canonicalJson({
      schemaVersion: 1,
      backend,
      sessionId,
      bootstrap: provenance?.bootstrap ?? [],
      entries: provenance?.entries ?? [],
    }))
    .digest('hex');
}

function isFinalProvenance(
  provenance: SeedProvenanceState | null,
  journal: SeedAppendJournal,
): boolean {
  if (!provenance || provenance.entries.length !== journal.base.provenanceEntryCount + journal.planned.length) {
    return false;
  }
  const prefix: SeedProvenanceState = {
    ...provenance,
    entries: provenance.entries.slice(0, journal.base.provenanceEntryCount),
  };
  if (provenanceStructureDigest(prefix, journal.backend, journal.sessionId) !== journal.base.provenanceDigest) {
    return false;
  }
  const suffix = provenance.entries.slice(journal.base.provenanceEntryCount);
  return suffix.every((entry, index) => sameProvenanceEntry(entry, expectedEntry(journal, index)));
}

function expectedEntry(journal: SeedAppendJournal, index: number): SeedProvenanceEntry {
  const planned = journal.planned[index]!;
  return {
    logicalId: planned.logicalId,
    contentDigest: planned.contentDigest,
    source: planned.source,
    target: {
      kind: 'native',
      backend: journal.backend,
      sessionId: journal.sessionId,
      nativeIds: planned.nativeIds,
    },
  };
}

function sameProvenanceEntry(a: SeedProvenanceEntry, b: SeedProvenanceEntry): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function fingerprintNativeTurns(turns: readonly NativeSessionTurn[]): readonly SeedAppendNativeFingerprint[] {
  return turns.map((turn) => ({
    contentDigest: contentDigest(turn.userText, turn.assistantText),
    nativeIds: cloneNativeTurnIds(turn.nativeIds),
  }));
}

function sameFingerprints(
  a: readonly SeedAppendNativeFingerprint[],
  b: readonly SeedAppendNativeFingerprint[],
): boolean {
  return a.length === b.length && a.every((turn, index) =>
    turn.contentDigest === b[index]!.contentDigest && sameNativeTurnIds(turn.nativeIds, b[index]!.nativeIds));
}

function assertNativeReadIdentityAndShape(
  read: NativeSessionReadResult,
  backend: string,
  sessionId: string,
): void {
  if (read.backend !== backend || read.sessionId !== sessionId) {
    throw divergenceError('pending seed append Reader returned a different backend or session');
  }
  if (!isNativeStateDigest(read.nativeStateDigest)) {
    throw divergenceError('pending seed append Reader did not prove complete native state');
  }
  const seen = new Set<string>();
  for (const turn of read.turns) {
    if (turn.userText.length === 0 || turn.assistantText.length === 0) {
      throw divergenceError('pending seed append Reader returned an empty logical turn');
    }
    assertSeedAppendNativeIds(turn.nativeIds, 'pending seed append Reader', EXIT_CODES.protocolViolation);
    for (const id of uniqueNativeTurnIds(turn.nativeIds)) {
      if (seen.has(id)) {
        throw divergenceError('pending seed append Reader reused a native id across turns');
      }
      seen.add(id);
    }
  }
}

function assertSafeIdentity(backend: string, sessionId: string, source: string): void {
  if (backend.length === 0 || !isSafeSessionId(sessionId)) {
    throw stateError(`invalid ${source} identity`);
  }
}

function backendKey(backend: string): string {
  return createHash('sha256')
    .update('openp.seed.pending.backend.v1')
    .update('\0')
    .update(backend)
    .digest('hex')
    .slice(0, 24);
}

function stateError(message: string, details?: Readonly<Record<string, unknown>>): OpenPError {
  return new OpenPError(message, EXIT_CODES.sessionState, { details });
}

function divergenceError(message: string): OpenPError {
  return new OpenPError(message, EXIT_CODES.protocolViolation);
}

function isNotFoundError(error: unknown): boolean {
  return isErrorCode(error, 'ENOENT');
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { readonly code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
