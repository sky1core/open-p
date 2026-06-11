import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseDocument } from 'yaml';
import { BUILT_IN_BACKEND_IDS, type BuiltInBackendId } from './backend-ids.js';
import { EXIT_CODES, OpenPError } from './errors.js';

export interface ConfiguredBackendInstance {
  readonly id: string;
  readonly backend: BuiltInBackendId;
  readonly configDir: string;
}

const CONFIGURED_INSTANCE_BACKENDS = new Set<string>(['claude']);

export function resolveConfiguredBackendInstancesPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveXdgConfigHome(env.XDG_CONFIG_HOME);
  return join(base, 'open-p', 'instances.yaml');
}

export async function loadConfiguredBackendInstances(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly path?: string;
  readonly builtInBackendIds?: readonly string[];
  readonly supportedBackendIds?: ReadonlySet<string>;
} = {}): Promise<readonly ConfiguredBackendInstance[]> {
  const path = options.path ?? resolveConfiguredBackendInstancesPath(options.env ?? process.env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw new OpenPError(
      `failed to read configured backend instances: ${path}: ${readFailureReason(error)}`,
      EXIT_CODES.usage,
    );
  }

  const builtInBackendIds = new Set(options.builtInBackendIds ?? BUILT_IN_BACKEND_IDS);
  const supportedBackendIds = options.supportedBackendIds ?? CONFIGURED_INSTANCE_BACKENDS;
  const parsed = parseConfiguredInstanceYaml(text, path);
  return parseConfiguredInstances(parsed, {
    path,
    builtInBackendIds,
    supportedBackendIds,
  });
}

function parseConfiguredInstanceYaml(text: string, path: string): unknown {
  let document;
  try {
    document = parseDocument(text, {
      prettyErrors: false,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new OpenPError(
      `failed to parse configured backend instances: ${path}: ${errorMessage(error)}`,
      EXIT_CODES.usage,
    );
  }
  if (document.errors.length > 0) {
    throw new OpenPError(
      `failed to parse configured backend instances: ${path}: ${document.errors.map((error) => error.message).join('; ')}`,
      EXIT_CODES.usage,
    );
  }
  return document.toJS();
}

function parseConfiguredInstances(
  value: unknown,
  options: {
    readonly path: string;
    readonly builtInBackendIds: ReadonlySet<string>;
    readonly supportedBackendIds: ReadonlySet<string>;
  },
): readonly ConfiguredBackendInstance[] {
  const root = asRecord(value);
  if (!root) {
    throw usageError(options.path, 'root value must be an object');
  }
  assertAllowedKeys(root, ROOT_KEYS, 'root', options.path);
  const instances = asRecord(root.instances);
  if (!instances) {
    throw usageError(options.path, 'instances must be an object');
  }

  const output: ConfiguredBackendInstance[] = [];
  for (const [id, rawConfig] of Object.entries(instances)) {
    if (!id) {
      throw usageError(options.path, 'instance id must not be empty');
    }
    if (id.startsWith('-')) {
      throw usageError(options.path, `instance id must not start with -: ${id}`);
    }
    if (/\s/.test(id)) {
      throw usageError(options.path, `instance id must not contain whitespace: ${id}`);
    }
    if (options.builtInBackendIds.has(id)) {
      throw usageError(options.path, `instance id must not collide with built-in backend id: ${id}`);
    }

    const config = asRecord(rawConfig);
    if (!config) {
      throw usageError(options.path, `instance ${id} must be an object`);
    }
    assertAllowedKeys(config, INSTANCE_KEYS, `instance ${id}`, options.path);
    if (typeof config.backend !== 'string' || !config.backend) {
      throw usageError(options.path, `instance ${id} backend is required`);
    }
    if (!options.builtInBackendIds.has(config.backend)) {
      throw usageError(options.path, `instance ${id} backend is not a built-in backend: ${config.backend}`);
    }
    if (!options.supportedBackendIds.has(config.backend)) {
      throw usageError(options.path, `instance ${id} backend ${config.backend} does not support configured instances`);
    }
    if (typeof config.configDir !== 'string' || !config.configDir) {
      throw usageError(options.path, `instance ${id} configDir is required`);
    }

    output.push({
      id,
      backend: config.backend as BuiltInBackendId,
      configDir: resolveInstanceConfigDir(config.configDir, options.path, id),
    });
  }
  return output;
}

function resolveInstanceConfigDir(value: string, path: string, instanceId: string): string {
  if (value === '~') {
    return homedir().normalize('NFC');
  }
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2)).normalize('NFC');
  }
  if (!isAbsolute(value)) {
    throw usageError(path, `instance ${instanceId} configDir must be absolute or use ~/ expansion`);
  }
  return value.normalize('NFC');
}

const ROOT_KEYS = new Set<string>(['instances']);
const INSTANCE_KEYS = new Set<string>(['backend', 'configDir']);

function resolveXdgConfigHome(value: string | undefined): string {
  if (typeof value === 'string' && value && isAbsolute(value)) {
    return value;
  }
  return join(homedir(), '.config');
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw usageError(path, `${label} has unknown key: ${key}`);
    }
  }
}

function usageError(path: string, message: string): OpenPError {
  return new OpenPError(`invalid configured backend instances: ${path}: ${message}`, EXIT_CODES.usage);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function readFailureReason(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const message = errorMessage(error);
  return typeof code === 'string' && code ? `${code}: ${message}` : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
