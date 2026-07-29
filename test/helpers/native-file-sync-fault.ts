import { open, writeFile } from 'node:fs/promises';

interface FileHandlePrototype {
  sync(): Promise<void>;
}

export interface InstalledFileSyncDrift {
  wasTriggered(): boolean;
  restore(): void;
}

// Installs a one-shot fault at the real FileHandle.sync boundary. A production Reader first reads
// its native file, then enters settlement and calls sync; replacing the bytes at that exact call
// deterministically proves that the Reader wires settlement mode to the stable-snapshot check.
export async function installFileDriftOnNextSync(
  path: string,
  replacement: Uint8Array,
): Promise<InstalledFileSyncDrift> {
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
  await probe.close();
  const originalSync = prototype.sync;
  let triggered = false;
  const patchedSync = async function(this: unknown): Promise<void> {
    await Reflect.apply(originalSync, this, []);
    if (!triggered) {
      triggered = true;
      await writeFile(path, replacement);
    }
  };
  prototype.sync = patchedSync;
  return {
    wasTriggered: () => triggered,
    restore: () => {
      if (prototype.sync === patchedSync) {
        prototype.sync = originalSync;
      }
    },
  };
}
