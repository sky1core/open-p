import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const SEED_STORAGE_IDENTITY_SCHEME = 'openp-native-store-v1' as const;

export interface SeedStorageIdentity {
  readonly scheme: typeof SEED_STORAGE_IDENTITY_SCHEME;
  readonly digest: string;
}

export function createSeedStorageIdentity(input: {
  readonly backendFamily: string;
  readonly providerId: string;
  readonly cwd: string;
  readonly storageRoot: string;
}): SeedStorageIdentity {
  const storageRoot = resolve(input.cwd, input.storageRoot).normalize('NFC');
  return {
    scheme: SEED_STORAGE_IDENTITY_SCHEME,
    digest: createHash('sha256')
      .update('openp.seed.native-store.v1')
      .update('\0')
      .update(JSON.stringify({
        backendFamily: input.backendFamily,
        providerId: input.providerId,
        storageRoot,
      }))
      .digest('hex'),
  };
}
