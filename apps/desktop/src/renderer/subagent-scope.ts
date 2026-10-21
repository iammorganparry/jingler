/** Pure selectors for content scoped to the viewed subagent (the scope value lives in subagent-view-machine). */
import type { SubagentFleetNode } from "@jingler/core"

type ScopedChild = Pick<SubagentFleetNode, "subagentId" | "prNumber" | "workspace">

/** The child's PR while content is scoped to it; null keeps the session's own PR. */
export const scopedPrNumber = (viewed: ScopedChild | null, scope: string): number | null =>
  viewed !== null && scope === viewed.subagentId ? viewed.prNumber : null

/** New terminals start in the viewed child's worktree, else the session's. */
export const terminalCwd = (
  viewed: Pick<SubagentFleetNode, "workspace"> | null,
  sessionWorktreePath: string | null | undefined
): string | undefined => viewed?.workspace?.path ?? sessionWorktreePath ?? undefined

export type ScopeBarState = "active" | "empty" | "removed"

/**
 * A child that reported changed lines but now lists no files had its worktree removed
 * (merged or discarded; the runtime doesn't say which). Otherwise no files means nothing yet.
 */
export const scopeBarState = (child: Pick<SubagentFleetNode, "workspace">, fileCount: number): ScopeBarState => {
  if (fileCount > 0) return "active"
  const reported = (child.workspace?.diff?.added ?? 0) + (child.workspace?.diff?.removed ?? 0)
  return reported > 0 ? "removed" : "empty"
}
