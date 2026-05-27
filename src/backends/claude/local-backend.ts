import type { BackendDescriptor } from '../../core/worker-types.js';
import { CLAUDE_CODE_DESCRIPTOR } from './descriptor.js';

export interface LocalClaudeCodeModelConfig {
  readonly id: string;
  readonly label?: string;
  readonly maxContextTokens?: number;
  readonly defaultReasoningEffort?: string;
  readonly reasoningEfforts?: readonly string[];
}

export interface LocalClaudeCodeBackendConfig {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
  readonly baseUrl?: string;
  readonly anthropicBaseUrl?: string;
  readonly defaultModel?: string;
  readonly models?: readonly LocalClaudeCodeModelConfig[];
}

export interface LocalClaudeCodeWorkerDefaults {
  readonly local: true;
  readonly env: Readonly<Record<string, string>>;
  readonly model: string | null;
  readonly contextWindowsByModel: Readonly<Record<string, number>>;
  readonly contextWindow: number | null;
}

export interface LocalClaudeCodeBackendRuntime {
  readonly id: string;
  readonly descriptor: BackendDescriptor;
  readonly workerDefaults: LocalClaudeCodeWorkerDefaults;
}

export function buildLocalClaudeCodeEnv(config: LocalClaudeCodeBackendConfig): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  const baseUrl = config.anthropicBaseUrl ?? config.baseUrl;
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
  }

  return env;
}

export function buildLocalClaudeCodeBackendRuntime(config: LocalClaudeCodeBackendConfig): LocalClaudeCodeBackendRuntime {
  const descriptor = buildLocalClaudeCodeDescriptor(config);
  return {
    id: descriptor.id,
    descriptor,
    workerDefaults: {
      local: true,
      env: buildLocalClaudeCodeEnv(config),
      model: descriptor.defaultModel,
      contextWindowsByModel: descriptor.contextWindowsByModel,
      contextWindow: descriptor.contextWindow,
    },
  };
}

export function buildLocalClaudeCodeDescriptor(config: LocalClaudeCodeBackendConfig): BackendDescriptor {
  validateLocalClaudeCodeBackendConfig(config);
  const models = config.models ?? [];
  const contextWindowsByModel = Object.fromEntries(
    models
      .filter((model) => typeof model.maxContextTokens === 'number' && Number.isFinite(model.maxContextTokens))
      .map((model) => [model.id, model.maxContextTokens!]),
  );
  const reasoningEffortsByModel = Object.fromEntries(
    models
      .filter((model) => model.reasoningEfforts && model.reasoningEfforts.length > 0)
      .map((model) => [model.id, model.reasoningEfforts!]),
  );
  const defaultReasoningEffortsByModel = Object.fromEntries(
    models
      .filter((model) => model.defaultReasoningEffort)
      .map((model) => [model.id, model.defaultReasoningEffort!]),
  );

  return {
    ...CLAUDE_CODE_DESCRIPTOR,
    id: config.id,
    label: config.label ?? config.id,
    description: config.description ?? CLAUDE_CODE_DESCRIPTOR.description,
    defaultModel: config.defaultModel ?? models[0]?.id ?? null,
    models: models.map((model) => model.id),
    modelSource: 'config/models.yaml',
    defaultReasoningEffortsByModel,
    reasoningEffortsByModel,
    contextWindowsByModel,
    contextWindow: null,
  };
}

export function validateLocalBackendId(id: string): void {
  if (id === 'claude' || id === 'codex') {
    throw new Error(`local backend id must not collide with built-in backend id: ${id}`);
  }
}

export function validateLocalClaudeCodeBackendConfig(config: LocalClaudeCodeBackendConfig): void {
  validateLocalBackendId(config.id);
  if (!config.defaultModel) {
    return;
  }

  const modelIds = new Set((config.models ?? []).map((model) => model.id));
  if (!modelIds.has(config.defaultModel)) {
    throw new Error(`claude backend defaultModel must match a configured model id: ${config.defaultModel}`);
  }
}
