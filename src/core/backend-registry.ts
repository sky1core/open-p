import { EXIT_CODES, OpenPError } from './errors.js';
import type { BackendProvider } from './backend.js';

const registry = new Map<string, BackendProvider>();
const aliasToId = new Map<string, string>();

export function registerBackend(provider: BackendProvider): void {
  const existing = registry.get(provider.id);
  if (existing) {
    for (const alias of existing.aliases) {
      aliasToId.delete(alias);
    }
  }
  registry.set(provider.id, provider);
  for (const alias of provider.aliases) {
    aliasToId.set(alias, provider.id);
  }
}

export function getBackendProvider(idOrAlias: string): BackendProvider {
  const provider = registry.get(idOrAlias) ?? registry.get(aliasToId.get(idOrAlias) ?? '');
  if (!provider) {
    const available = [...registry.keys()].join(', ') || '(none)';
    throw new OpenPError(`unsupported backend: ${idOrAlias} (available: ${available})`, EXIT_CODES.unsupportedOption);
  }
  return provider;
}

export function resolveCanonicalBackendId(idOrAlias: string): string {
  return getBackendProvider(idOrAlias).id;
}

export function getRegisteredBackendIds(): readonly string[] {
  return [...registry.keys()];
}

export function getKnownBackendNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [id, provider] of registry) {
    names.add(id);
    for (const alias of provider.aliases) {
      names.add(alias);
    }
  }
  return names;
}
