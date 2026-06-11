export const BUILT_IN_BACKEND_IDS = ['claude', 'codex', 'kiro'] as const;

export type BuiltInBackendId = typeof BUILT_IN_BACKEND_IDS[number];

export function isBuiltInBackendId(id: string): id is BuiltInBackendId {
  return (BUILT_IN_BACKEND_IDS as readonly string[]).includes(id);
}
