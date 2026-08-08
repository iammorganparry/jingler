import type { AssetFileEntry } from "@jingler/core"

const ASSET_LIST_TIMEOUT_MS = 5_000

export interface RepositoryFileApis {
  readonly assetList: (sessionId: string) => Promise<ReadonlyArray<AssetFileEntry>>
  readonly workspaceFiles: (worktreePath: string) => Promise<ReadonlyArray<string>>
}

/**
 * Prefer the validated, status-aware asset inventory. If that dedicated RPC
 * returns an empty first scan or never settles in a busy renderer, fall back to
 * Workspace.files, the established core-RPC inventory used by code references.
 * Reads and writes still pass through AssetService's main-process containment
 * checks, so the fallback grants no filesystem authority to the renderer.
 */
export const listRepositoryFiles = async (
  apis: RepositoryFileApis,
  sessionId: string,
  worktreePath: string | undefined,
  timeoutMs = ASSET_LIST_TIMEOUT_MS
): Promise<ReadonlyArray<AssetFileEntry>> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const entries = await Promise.race([
      apis.assetList(sessionId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out loading the repository inventory")),
          timeoutMs
        )
      })
    ])
    if (entries.length > 0 || worktreePath === undefined) return entries
  } catch (error) {
    if (worktreePath === undefined) throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  if (worktreePath === undefined) return []
  const paths = await apis.workspaceFiles(worktreePath)
  return paths.map((path) => ({ path, status: "clean" as const }))
}
