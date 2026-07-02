import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';

export interface OpenCodeLocalProviderConfig {
  readonly name: string;
  readonly baseURL: string;
}

const LOCAL_MODEL_PROVIDER_CONFIGS = {
  'mlx-lm': {
    name: 'MLX-LM Server (local)',
    baseURL: 'http://localhost:8091/v1',
  },
  lmstudio: {
    name: 'LM Studio (local)',
    baseURL: 'http://localhost:1234/v1',
  },
  ollama: {
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
  },
  'llama.cpp': {
    name: 'llama-server (local)',
    baseURL: 'http://localhost:8080/v1',
  },
} as const satisfies Record<string, OpenCodeLocalProviderConfig>;

export type OpenCodeLocalProvider = keyof typeof LOCAL_MODEL_PROVIDER_CONFIGS;

export interface OpenCodeLocalModel {
  readonly model: string;
  readonly provider: OpenCodeLocalProvider;
  readonly modelId: string;
  readonly providerConfig: OpenCodeLocalProviderConfig;
}

export interface OpenCodeArgsOptions {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly executionMode: string | null;
  readonly tools: string | null;
  readonly jsonSchema: string | null;
  readonly backendArgs: readonly string[];
}

export function buildOpenCodeArgs(input: {
  readonly message: string;
  readonly sessionId: string | null;
  readonly isFirstTurn: boolean;
  readonly options: OpenCodeArgsOptions;
}): readonly string[] {
  validateOpenCodeOptions(input.options);
  const model = requireLocalModel(input.options.model).model;
  const args = ['run', '--pure', '--format', 'json', '--model', model];

  if (!input.isFirstTurn) {
    if (!input.sessionId || !isSafeSessionId(input.sessionId)) {
      throw new OpenPError('unsafe OpenCode resume session id', EXIT_CODES.usage);
    }
    args.push('--session', input.sessionId);
  }

  if (input.options.reasoningEffort) {
    args.push('--variant', input.options.reasoningEffort);
  }
  if (input.options.executionMode === 'danger-full-access') {
    args.push('--dangerously-skip-permissions');
  }

  args.push(input.message);
  return args;
}

export function requireLocalModel(model: string | null): OpenCodeLocalModel {
  if (!model) {
    throw new OpenPError('OpenCode backend requires --model with a local provider prefix; prefer mlx-lm/<model-id> on Apple Silicon', EXIT_CODES.usage);
  }
  const separator = model.indexOf('/');
  const provider = separator > 0 ? model.slice(0, separator) : '';
  const modelId = separator > 0 ? model.slice(separator + 1) : '';
  if (!isOpenCodeLocalProvider(provider) || !modelId.trim()) {
    throw new OpenPError(
      `OpenCode local-private mode only allows configured local providers: ${Object.keys(LOCAL_MODEL_PROVIDER_CONFIGS).join(', ')}`,
      EXIT_CODES.unsupportedOption,
    );
  }
  return {
    model,
    provider,
    modelId,
    providerConfig: LOCAL_MODEL_PROVIDER_CONFIGS[provider],
  };
}

function isOpenCodeLocalProvider(value: string): value is OpenCodeLocalProvider {
  return Object.hasOwn(LOCAL_MODEL_PROVIDER_CONFIGS, value);
}

function validateOpenCodeOptions(options: OpenCodeArgsOptions): void {
  if (options.backendArgs.length > 0) {
    throw new OpenPError('OpenCode backend does not support backend passthrough args', EXIT_CODES.unsupportedOption);
  }
  if (options.tools !== null) {
    throw new OpenPError('OpenCode backend does not support public --tools yet', EXIT_CODES.unsupportedOption);
  }
  if (options.jsonSchema) {
    throw new OpenPError('OpenCode backend does not support --json-schema yet', EXIT_CODES.unsupportedOption);
  }
  if (
    options.executionMode !== null &&
    options.executionMode !== undefined &&
    options.executionMode !== 'default' &&
    options.executionMode !== 'danger-full-access'
  ) {
    throw new OpenPError(`unsupported OpenCode execution mode: ${options.executionMode}`, EXIT_CODES.unsupportedOption);
  }
}
