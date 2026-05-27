import { EXIT_CODES, OpenPError } from './errors.js';
import type { BackendProvider } from './backend.js';

const registry = new Map<string, BackendProvider>();

export function registerBackend(provider: BackendProvider): void {
  registry.set(provider.id, provider);
}

export function getBackendProvider(id: string): BackendProvider {
  const provider = registry.get(id);
  if (!provider) {
    const available = [...registry.keys()].join(', ') || '(none)';
    throw new OpenPError(`unsupported backend: ${id} (available: ${available})`, EXIT_CODES.unsupportedOption);
  }
  return provider;
}

export function resolveRegisteredBackendId(id: string): string {
  return getBackendProvider(id).id;
}

export function getRegisteredBackendIds(): readonly string[] {
  return [...registry.keys()];
}

export function getKnownBackendNames(): ReadonlySet<string> {
  return new Set(registry.keys());
}
