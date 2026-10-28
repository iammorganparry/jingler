export interface SubagentTreeNode {
  readonly id: string
  /** Owning node id; null, absent, or an id not in the list makes this a root. */
  readonly parentId?: string | null
}

export interface SubagentTreeRow<T extends SubagentTreeNode> {
  readonly item: T
  /** 0 for the orchestrator (root); +1 per ancestor. */
  readonly depth: number
}

/**
 * Flattens fleet nodes into pre-order rows (parent, then its children) with
 * depth. Siblings keep input order; orphans whose parent is missing become
 * roots; a parent cycle is cut so every node appears exactly once.
 */
export function buildSubagentTree<T extends SubagentTreeNode>(items: ReadonlyArray<T>): ReadonlyArray<SubagentTreeRow<T>> {
  const ids = new Set(items.map((item) => item.id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const item of items) {
    const parent = item.parentId
    if (parent == null || parent === item.id || !ids.has(parent)) roots.push(item)
    else children.set(parent, [...(children.get(parent) ?? []), item])
  }
  const rows: SubagentTreeRow<T>[] = []
  const seen = new Set<string>()
  const visit = (item: T, depth: number) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    rows.push({ item, depth })
    for (const child of children.get(item.id) ?? []) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  // Members of a pure cycle have no root; surface them rather than drop them.
  for (const item of items) visit(item, 0)
  return rows
}
