import type { BackendProvider } from './backend.js';

export interface PublicBackendLoginStatus {
  readonly id: string;
  readonly backend: string;
  readonly loggedIn: boolean;
}

export async function collectBackendLoginStatuses(
  providers: readonly BackendProvider[],
): Promise<readonly PublicBackendLoginStatus[]> {
  const statuses: PublicBackendLoginStatus[] = [];
  for (const provider of providers) {
    if (!provider.probeLogin) {
      continue;
    }
    const result = await provider.probeLogin();
    statuses.push({
      id: provider.id,
      backend: result.backend,
      loggedIn: result.loggedIn,
    });
  }
  return statuses;
}

export function formatBackendLoginStatuses(statuses: readonly PublicBackendLoginStatus[]): string {
  return `${JSON.stringify({
    openp: {
      version: 1,
      backends: statuses,
    },
  })}\n`;
}
