const LEGACY_KEY = "jingler:mcp-import-prompt:v1"

const legacyFlag = (): boolean => {
  try {
    return localStorage.getItem(LEGACY_KEY) === "done"
  } catch {
    return false
  }
}

/** Persisted dismissal; a pre-existing localStorage flag counts as dismissed and is migrated to the main process. */
export async function resolveImportDismissed(
  isDismissed: () => Promise<boolean>,
  persist: () => Promise<void>,
  legacy: () => boolean = legacyFlag
): Promise<boolean> {
  if (legacy()) {
    await persist().catch(() => {})
    return true
  }
  return isDismissed().catch(() => false)
}
