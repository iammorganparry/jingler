import type { AssetFileEntry, Session } from "@jingler/core"

const ASSET_LIST_TIMEOUT_MS = 5_000

export interface RepositoryFileApis {
  readonly assetList: (sessionId: string) => Promise<ReadonlyArray<AssetFileEntry>>
  readonly sessionsGet: (
    sessionId: string
  ) => Promise<Pick<Session, "worktreePath" | "environmentId">>
  readonly workspaceFiles: (
    worktreePath: string,
    environmentId?: string
  ) => Promise<ReadonlyArray<string>>
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
  let assetListError: unknown
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
    if (entries.length > 0) return entries
  } catch (error) {
    assetListError = error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  // A session actor can be created while its worktree is still being prepared,
  // then outlive the Session object that supplied its initial input. Resolve the
  // current record before falling back so an early undefined path cannot leave
  // that persistent actor permanently empty.
  const session = await apis.sessionsGet(sessionId).catch(() => null)
  const currentWorktreePath = session?.worktreePath ?? worktreePath
  if (currentWorktreePath === undefined) {
    if (assetListError !== undefined) throw assetListError
    return []
  }
  const paths = session?.environmentId
    ? await apis.workspaceFiles(currentWorktreePath, session.environmentId)
    : await apis.workspaceFiles(currentWorktreePath)
  return paths.map((path) => ({ path, status: "clean" as const }))
}
