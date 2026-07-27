export function resolveInteractivePermissionMode(input: {
  readonly permissionMode: string | null;
  readonly nativePermissionMode: string | null;
}): string | null {
  // A native mode is Claude's own value and reaches Claude unread: open-p does not know what any of
  // them mean, so it cannot decide that one of them stands for another. The trusted-tool intent is
  // the one thing open-p states in its own words, and it is what gets translated.
  if (input.nativePermissionMode !== null) {
    return input.nativePermissionMode;
  }
  if (input.permissionMode === 'danger-full-access') {
    return 'bypassPermissions';
  }
  return input.permissionMode;
}
