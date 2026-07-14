import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveOpenPStateRoot } from '../../core/state-root.js';
import type { OpenCodeLocalModel } from './args.js';

const CLOUD_ENV_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'QWEN_API_KEY',
  'REQUESTY_API_KEY',
  'XAI_API_KEY',
]);

const PASSTHROUGH_ENV_NAMES = new Set([
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
]);

export interface OpenCodePrivateEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;
}

export async function buildOpenCodePrivateEnv(
  projectRoot: string,
  baseEnv: NodeJS.ProcessEnv,
  model: OpenCodeLocalModel,
): Promise<OpenCodePrivateEnv> {
  const stateRoot = resolveOpenPStateRoot(projectRoot, baseEnv);
  const root = join(stateRoot, 'opencode');
  const homeDir = join(root, 'home');
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  await Promise.all([
    mkdir(homeDir, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(dataDir, { recursive: true, mode: 0o700 }),
    mkdir(cacheDir, { recursive: true, mode: 0o700 }),
  ]);

  const env = sanitizeOpenCodeEnv(baseEnv);
  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = configDir;
  env.XDG_DATA_HOME = dataDir;
  env.XDG_CACHE_HOME = cacheDir;
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildOpenCodeLocalConfig(model));
  return { env, homeDir, configDir, dataDir, cacheDir };
}

export function sanitizeOpenCodeEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!PASSTHROUGH_ENV_NAMES.has(key)) continue;
    if (isPrivateProviderEnv(key)) continue;
    if (CLOUD_ENV_NAMES.has(key)) continue;
    if (key.startsWith('OPENCODE_')) continue;
    if (key.startsWith('CLAUDE_')) continue;
    if (key.startsWith('CODEX_')) continue;
    env[key] = value;
  }
  return env;
}

function isPrivateProviderEnv(key: string): boolean {
  return key.endsWith('_API_KEY') ||
    key.endsWith('_ACCESS_KEY_ID') ||
    key.endsWith('_ACCESS_TOKEN') ||
    key.endsWith('_AUTH_TOKEN') ||
    key.endsWith('_TOKEN') ||
    key.endsWith('_PRIVATE_KEY') ||
    key.endsWith('_SECRET') ||
    key.endsWith('_SECRET_ACCESS_KEY') ||
    key.endsWith('_CREDENTIALS');
}

function buildOpenCodeLocalConfig(model: OpenCodeLocalModel): unknown {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    mcp: {},
    plugin: [],
    provider: {
      [model.provider]: {
        npm: '@ai-sdk/openai-compatible',
        name: model.providerConfig.name,
        options: {
          baseURL: model.providerConfig.baseURL,
        },
        models: {
          [model.modelId]: {
            name: `${model.modelId} (local)`,
          },
        },
      },
    },
  };
}
