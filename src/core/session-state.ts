import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EXIT_CODES, OpenPError } from './errors.js';
import { ensureDurableDirectory, syncDirectory, syncFile } from './fs-durability.js';
import {
  canonicalJson,
  parseSeedAppendJournal,
  type SeedAppendJournal,
} from './seed-append-journal-schema.js';
import { isSafeSessionId } from './session-id.js';
import { resolveOpenPStateRoot } from './state-root.js';
import { isCanonicalUuidV4 } from './uuid.js';

export type BackendId = string;

export interface SessionState {
  readonly schemaVersion: 1;
  readonly backend: BackendId;
  readonly backendSessionId: string;
  readonly cwd: string;
  readonly lastProviderSessionId: string | null;
  readonly sessionLogPath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTurnId: string | null;
}

export interface PendingSeedAppendSessionState {
  readonly schemaVersion: 2;
  readonly kind: 'pending-seed-append';
  readonly backend: BackendId;
  readonly backendSessionId: string;
  readonly cwd: string;
  readonly operationId: string;
  readonly createdAt: string;
  readonly restoreState: SessionState;
  readonly seedAppendJournal: SeedAppendJournal;
}

export interface SessionStateCompatibility {
  readonly backend: BackendId;
  readonly backendSessionId: string;
  readonly cwd: string;
}

export interface SaveSessionStateInput extends SessionStateCompatibility {
  readonly lastProviderSessionId: string | null;
  readonly sessionLogPath: string | null;
  readonly lastTurnId: string | null;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

export class SessionStateStore {
  private readonly stateRoot: string;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.stateRoot = stateRoot;
  }

  pathForSession(sessionId: string): string {
    assertValidSessionId(sessionId);
    return join(this.stateRoot, 'sessions', `${sessionId}.json`);
  }

  async load(sessionId: string): Promise<SessionState | null> {
    const path = this.pathForSession(sessionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new OpenPError(`failed to read session state: ${path}`, EXIT_CODES.sessionState);
    }

    if (!isUtf8(bytes)) {
      throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
    }
    const text = bytes.toString('utf8');

    try {
      return parseSessionState(JSON.parse(text), path, sessionId);
    } catch (error) {
      if (error instanceof OpenPError) {
        throw error;
      }
      throw new OpenPError(`failed to parse session state: ${path}`, EXIT_CODES.sessionState);
    }
  }

  async requireCompatible(expected: SessionStateCompatibility): Promise<SessionState> {
    const state = await this.load(expected.backendSessionId);
    if (!state) {
      throw new OpenPError(`session state not found for ${expected.backendSessionId}`, EXIT_CODES.sessionState);
    }
    validateSessionStateCompatibility(state, expected);
    return state;
  }

  async requireCompatibleForPendingSeedSettlement(expected: SessionStateCompatibility): Promise<SessionState> {
    const state = await this.loadForPendingSeedSettlement(expected.backendSessionId);
    if (!state) {
      throw new OpenPError(`session state not found for ${expected.backendSessionId}`, EXIT_CODES.sessionState);
    }
    const compatibleState = state.schemaVersion === 1 ? state : state.restoreState;
    validateSessionStateCompatibility(compatibleState, expected);
    return compatibleState;
  }

  async loadPendingSeedAppendMarker(sessionId: string): Promise<PendingSeedAppendSessionState | null> {
    const state = await this.loadForPendingSeedSettlement(sessionId);
    return state?.schemaVersion === 2 ? state : null;
  }

  async confirmCompatibleV1DurabilityIfPresent(expected: SessionStateCompatibility): Promise<void> {
    const before = await this.loadForPendingSeedSettlement(expected.backendSessionId);
    if (before === null) {
      // Native source sessions created outside open-p legitimately have no open-p session state.
      return;
    }
    if (before.schemaVersion !== 1) {
      throw new OpenPError(
        `session ${expected.backendSessionId} still has a pending seed marker`,
        EXIT_CODES.sessionState,
      );
    }
    validateSessionStateCompatibility(before, expected);
    const path = this.pathForSession(expected.backendSessionId);
    try {
      // This closes the retry window where a v1 rename was visible but the previous sessions-dir
      // fsync failed. The file is synced first, then the directory entry, then identity is re-read.
      await syncFile(path);
      await syncDirectory(dirname(path));
    } catch {
      throw new OpenPError(`failed to confirm session state durability: ${path}`, EXIT_CODES.sessionState);
    }
    const after = await this.load(expected.backendSessionId);
    if (!after || canonicalJson(after) !== canonicalJson(before)) {
      throw new OpenPError(`session state changed during durability confirmation: ${path}`, EXIT_CODES.sessionState);
    }
  }

  async publishPendingSeedAppendMarker(input: {
    readonly restoreState: SessionState;
    readonly seedAppendJournal: SeedAppendJournal;
  }): Promise<PendingSeedAppendSessionState> {
    const restoreState = parseSessionState(
      input.restoreState,
      'pending seed restore state input',
      input.restoreState.backendSessionId,
    );
    const journal = parseSeedAppendJournal(input.seedAppendJournal, 'pending seed session marker journal input');
    const current = await this.load(restoreState.backendSessionId);
    if (!current || canonicalJson(current) !== canonicalJson(restoreState)) {
      throw new OpenPError(
        'session state changed before pending seed marker publication',
        EXIT_CODES.sessionState,
      );
    }
    const marker = parsePendingSeedAppendSessionState({
      schemaVersion: 2,
      kind: 'pending-seed-append',
      backend: restoreState.backend,
      backendSessionId: restoreState.backendSessionId,
      cwd: restoreState.cwd,
      operationId: journal.operationId,
      createdAt: journal.createdAt,
      restoreState,
      seedAppendJournal: journal,
    }, 'pending seed session marker input', restoreState.backendSessionId);
    await this.writeSessionStateObject(marker.backendSessionId, marker);
    return marker;
  }

  async restorePendingSeedAppendMarker(marker: PendingSeedAppendSessionState): Promise<void> {
    const checked = parsePendingSeedAppendSessionState(
      marker,
      'pending seed session marker restore input',
      marker.backendSessionId,
    );
    const current = await this.loadPendingSeedAppendMarker(checked.backendSessionId);
    if (!current || canonicalJson(current) !== canonicalJson(checked)) {
      throw new OpenPError(`pending seed session marker changed before restore`, EXIT_CODES.sessionState);
    }
    await this.writeSessionStateObject(checked.backendSessionId, checked.restoreState);
  }

  async save(input: SaveSessionStateInput): Promise<SessionState> {
    const existing = await this.load(input.backendSessionId);
    if (existing) {
      validateSessionStateCompatibility(existing, input);
    }

    const now = new Date().toISOString();
    const state: SessionState = {
      schemaVersion: 1,
      backend: input.backend,
      backendSessionId: input.backendSessionId,
      cwd: input.cwd,
      lastProviderSessionId: input.lastProviderSessionId,
      sessionLogPath: input.sessionLogPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastTurnId: input.lastTurnId,
    };

    await this.writeSessionStateObject(input.backendSessionId, state);
    return state;
  }

  private async loadForPendingSeedSettlement(
    sessionId: string,
  ): Promise<SessionState | PendingSeedAppendSessionState | null> {
    const path = this.pathForSession(sessionId);
    const value = await this.readSessionStateJson(path);
    if (value === null) {
      return null;
    }
    if (asObject(value)?.schemaVersion === 2) {
      return parsePendingSeedAppendSessionState(value, path, sessionId);
    }
    return parseSessionState(value, path, sessionId);
  }

  private async readSessionStateJson(path: string): Promise<unknown | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new OpenPError(`failed to read session state: ${path}`, EXIT_CODES.sessionState);
    }
    if (!isUtf8(bytes)) {
      throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
    }
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new OpenPError(`failed to parse session state: ${path}`, EXIT_CODES.sessionState);
    }
  }

  private async writeSessionStateObject(
    sessionId: string,
    state: SessionState | PendingSeedAppendSessionState,
  ): Promise<void> {
    const directory = join(this.stateRoot, 'sessions');
    await ensureDurableDirectory(directory);
    const path = this.pathForSession(sessionId);
    const tempPath = join(directory, `.session-${randomUUID()}.tmp`);
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
      await syncDirectory(directory);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (error instanceof OpenPError) throw error;
      throw new OpenPError(`failed to write session state: ${path}`, EXIT_CODES.sessionState);
    }
  }
}

export function validateSessionStateCompatibility(state: SessionState, expected: SessionStateCompatibility): void {
  if (state.backend !== expected.backend) {
    throw new OpenPError(`session ${expected.backendSessionId} belongs to backend ${state.backend}`, EXIT_CODES.sessionState);
  }
  if (state.backendSessionId !== expected.backendSessionId) {
    throw new OpenPError(`session state id mismatch for ${expected.backendSessionId}`, EXIT_CODES.sessionState);
  }
  if (state.cwd !== expected.cwd) {
    throw new OpenPError(`session ${expected.backendSessionId} belongs to a different workspace: ${state.cwd}`, EXIT_CODES.sessionState);
  }
}

function parseSessionState(value: unknown, path: string, expectedSessionId: string): SessionState {
  const object = exactObject(value, [
    'schemaVersion',
    'backend',
    'backendSessionId',
    'cwd',
    'lastProviderSessionId',
    'sessionLogPath',
    'createdAt',
    'updatedAt',
    'lastTurnId',
  ]);
  if (!object) {
    throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
  }

  const state = {
    schemaVersion: object.schemaVersion,
    backend: object.backend,
    backendSessionId: object.backendSessionId,
    cwd: object.cwd,
    lastProviderSessionId: object.lastProviderSessionId,
    sessionLogPath: object.sessionLogPath,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    lastTurnId: object.lastTurnId,
  };

  if (
    state.schemaVersion !== 1 ||
    typeof state.backend !== 'string' || !state.backend ||
    typeof state.backendSessionId !== 'string' || !isSafeSessionId(state.backendSessionId) ||
    state.backendSessionId !== expectedSessionId ||
    typeof state.cwd !== 'string' || state.cwd.length === 0 ||
    !isNullableString(state.lastProviderSessionId) ||
    !isNullableString(state.sessionLogPath) ||
    !validDate(state.createdAt) ||
    !validDate(state.updatedAt) ||
    !isNullableString(state.lastTurnId)
  ) {
    throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
  }

  return state as SessionState;
}

function parsePendingSeedAppendSessionState(
  value: unknown,
  path: string,
  expectedSessionId: string,
): PendingSeedAppendSessionState {
  const object = exactObject(value, [
    'schemaVersion',
    'kind',
    'backend',
    'backendSessionId',
    'cwd',
    'operationId',
    'createdAt',
    'restoreState',
    'seedAppendJournal',
  ]);
  if (!object || object.schemaVersion !== 2 || object.kind !== 'pending-seed-append' ||
    typeof object.backend !== 'string' || object.backend.length === 0 ||
    typeof object.backendSessionId !== 'string' || !isSafeSessionId(object.backendSessionId) ||
    object.backendSessionId !== expectedSessionId ||
    typeof object.cwd !== 'string' || object.cwd.length === 0 ||
    !isCanonicalUuidV4(object.operationId) ||
    !validDate(object.createdAt)) {
    throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
  }
  const restoreState = parseSessionState(object.restoreState, `${path} restoreState`, expectedSessionId);
  const seedAppendJournal = parseSeedAppendJournal(object.seedAppendJournal, `${path} seedAppendJournal`);
  if (
    restoreState.backend !== object.backend ||
    restoreState.backendSessionId !== object.backendSessionId ||
    restoreState.cwd !== object.cwd ||
    seedAppendJournal.backend !== object.backend ||
    seedAppendJournal.sessionId !== object.backendSessionId ||
    seedAppendJournal.operationId !== object.operationId ||
    seedAppendJournal.createdAt !== object.createdAt
  ) {
    throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
  }
  return {
    schemaVersion: 2,
    kind: 'pending-seed-append',
    backend: object.backend,
    backendSessionId: object.backendSessionId,
    cwd: object.cwd,
    operationId: object.operationId,
    createdAt: object.createdAt,
    restoreState,
    seedAppendJournal,
  };
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

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function assertValidSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError(`invalid session id for state path: ${sessionId}`, EXIT_CODES.sessionState);
  }
}
