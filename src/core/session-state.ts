import { mkdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT_CODES, OpenPError } from './errors.js';
import { resolveOpenPStateRoot } from './state-root.js';

export type BackendId = 'claude-code';
export type ProviderId = 'tmux';

export interface SessionState {
  readonly schemaVersion: 1;
  readonly backend: BackendId;
  readonly provider: ProviderId;
  readonly backendSessionId: string;
  readonly cwd: string;
  readonly lastProviderSessionId: string | null;
  readonly sessionLogPath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTurnId: string | null;
}

export interface SessionStateCompatibility {
  readonly backend: BackendId;
  readonly provider: ProviderId;
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
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw new OpenPError(`failed to read session state: ${path}`, EXIT_CODES.sessionState);
    }

    try {
      return parseSessionState(JSON.parse(text), path);
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

  async save(input: SaveSessionStateInput): Promise<SessionState> {
    const existing = await this.load(input.backendSessionId);
    if (existing) {
      validateSessionStateCompatibility(existing, input);
    }

    const now = new Date().toISOString();
    const state: SessionState = {
      schemaVersion: 1,
      backend: input.backend,
      provider: input.provider,
      backendSessionId: input.backendSessionId,
      cwd: input.cwd,
      lastProviderSessionId: input.lastProviderSessionId,
      sessionLogPath: input.sessionLogPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastTurnId: input.lastTurnId,
    };

    await mkdir(join(this.stateRoot, 'sessions'), { recursive: true, mode: 0o700 });
    const path = this.pathForSession(input.backendSessionId);
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
    return state;
  }
}

export function validateSessionStateCompatibility(state: SessionState, expected: SessionStateCompatibility): void {
  if (state.backend !== expected.backend) {
    throw new OpenPError(`session ${expected.backendSessionId} belongs to backend ${state.backend}`, EXIT_CODES.sessionState);
  }
  if (state.provider !== expected.provider) {
    throw new OpenPError(`session ${expected.backendSessionId} belongs to provider ${state.provider}`, EXIT_CODES.sessionState);
  }
  if (state.backendSessionId !== expected.backendSessionId) {
    throw new OpenPError(`session state id mismatch for ${expected.backendSessionId}`, EXIT_CODES.sessionState);
  }
  if (state.cwd !== expected.cwd) {
    throw new OpenPError(`session ${expected.backendSessionId} belongs to a different workspace: ${state.cwd}`, EXIT_CODES.sessionState);
  }
}

function parseSessionState(value: unknown, path: string): SessionState {
  const object = asObject(value);
  if (!object) {
    throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
  }

  const state = {
    schemaVersion: object.schemaVersion,
    backend: object.backend,
    provider: object.provider,
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
    state.backend !== 'claude-code' ||
    state.provider !== 'tmux' ||
    typeof state.backendSessionId !== 'string' ||
    typeof state.cwd !== 'string' ||
    !isNullableString(state.lastProviderSessionId) ||
    !isNullableString(state.sessionLogPath) ||
    typeof state.createdAt !== 'string' ||
    typeof state.updatedAt !== 'string' ||
    !isNullableString(state.lastTurnId)
  ) {
    throw new OpenPError(`invalid session state: ${path}`, EXIT_CODES.sessionState);
  }

  return state as SessionState;
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new OpenPError(`invalid session id for state path: ${sessionId}`, EXIT_CODES.sessionState);
  }
}
