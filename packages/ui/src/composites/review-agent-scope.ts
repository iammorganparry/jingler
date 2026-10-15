import type { PrFileChange } from "@jingler/core"

export const CHANGES_SCOPE_ALL = "all"
export const CHANGES_SCOPE_MAIN = "main"

/** One checkout's changed files: the main session tree or one subagent's worktree. */
export interface AgentTreeChanges {
  /** The subagent's id; null for the main checkout. */
  readonly agentId: string | null
  readonly label: string
  readonly files: readonly PrFileChange[]
}

/** One file row in the agent-scoped Changes list; a file touched by two trees has two rows. */
export interface AgentFileRow {
  readonly key: string
  readonly agentId: string | null
  readonly label: string
  readonly file: PrFileChange
}

const treeInScope = (tree: AgentTreeChanges, scope: string): boolean =>
  scope === CHANGES_SCOPE_ALL ||
  (scope === CHANGES_SCOPE_MAIN ? tree.agentId === null : tree.agentId === scope)

/** Merge per-tree file lists into one path-ordered list, one row per (tree, file). */
export const mergeAgentTrees = (
  trees: readonly AgentTreeChanges[],
  scope: string
): readonly AgentFileRow[] =>
  trees
    .filter((tree) => treeInScope(tree, scope))
    .flatMap((tree) =>
      tree.files.map((file) => ({
        key: `${tree.agentId ?? CHANGES_SCOPE_MAIN}:${file.path}`,
        agentId: tree.agentId,
        label: tree.label,
        file
      }))
    )
    .sort((a, b) => a.file.path.localeCompare(b.file.path) || a.label.localeCompare(b.label))

/** Header totals: every row's additions and deletions summed. */
export const sumAgentRows = (
  rows: readonly AgentFileRow[]
): { readonly added: number; readonly removed: number } => ({
  added: rows.reduce((sum, row) => sum + row.file.additions, 0),
  removed: rows.reduce((sum, row) => sum + row.file.deletions, 0)
})
