import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import {
  buildLocalClaudeCodeBackendRuntime,
  type LocalClaudeCodeBackendConfig,
  type LocalClaudeCodeBackendRuntime,
  type LocalClaudeCodeModelConfig,
  validateLocalClaudeCodeBackendConfig,
} from './local-backend.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

export async function loadLocalClaudeCodeBackendsFromModelsYaml(path: string): Promise<readonly LocalClaudeCodeBackendConfig[]> {
  const document = parseYaml(await readFile(path, 'utf8'));
  return extractBackendObjects(document)
    .filter((backend) => backend.kind === 'claude-code')
    .map(toLocalClaudeCodeBackendConfig);
}

export async function loadLocalClaudeCodeBackendRuntimesFromModelsYaml(path: string): Promise<readonly LocalClaudeCodeBackendRuntime[]> {
  const configs = await loadLocalClaudeCodeBackendsFromModelsYaml(path);
  return configs.map((config) => buildLocalClaudeCodeBackendRuntime(config));
}

function extractBackendObjects(document: unknown): readonly JsonObject[] {
  if (Array.isArray(document)) {
    return document.map(asObject).filter((value): value is JsonObject => value !== null);
  }

  const root = asObject(document);
  if (!root) {
    return [];
  }
  if (root.kind === 'claude-code') {
    return [root];
  }

  const backends = root.backends;
  if (Array.isArray(backends)) {
    return backends.map(asObject).filter((value): value is JsonObject => value !== null);
  }
  const backendMap = asObject(backends);
  if (backendMap) {
    return Object.entries(backendMap)
      .map(([id, value]) => withImplicitId(id, value))
      .filter((value): value is JsonObject => value !== null);
  }
  return [];
}

function toLocalClaudeCodeBackendConfig(backend: JsonObject): LocalClaudeCodeBackendConfig {
  const id = stringField(backend.id);
  if (!id) {
    throw new Error('claude-code backend config requires id');
  }
  const config = {
    id,
    label: stringField(backend.label),
    description: stringField(backend.description),
    baseUrl: stringField(backend.baseUrl),
    anthropicBaseUrl: stringField(backend.anthropicBaseUrl),
    defaultModel: stringField(backend.defaultModel),
    models: parseModels(backend.models),
  };
  validateLocalClaudeCodeBackendConfig(config);
  return config;
}

function parseModels(value: unknown): readonly LocalClaudeCodeModelConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(asObject).filter((model): model is JsonObject => model !== null).map((model) => {
    const id = stringField(model.id);
    if (!id) {
      throw new Error('claude-code model config requires id');
    }
    return {
      id,
      label: stringField(model.label),
      maxContextTokens: numberField(model.maxContextTokens),
      defaultReasoningEffort: stringField(model.defaultReasoningEffort),
      reasoningEfforts: parseStringArray(model.reasoningEfforts),
    };
  });
}

function withImplicitId(id: string, value: unknown): JsonObject | null {
  const object = asObject(value);
  if (!object) {
    return null;
  }
  return object.id ? object : { ...object, id };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}
