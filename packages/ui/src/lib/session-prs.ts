import type { SubagentFleetNode } from "@jingler/core"

/** One row in the session's PR chip menu: a main-session PR or a subagent's PR. */
export interface SessionPrRow {
  readonly number: number
  readonly agent: string
  /** Repo of the checkout this PR lives in; set only for multi-checkout sessions. */
  readonly repo?: string
  readonly branch: string | null
  readonly state?: string
  /** The fleet node this row came from — absent for the main row, which has no node. */
  readonly nodeId?: string
}

/**
 * Every PR open under this session: the main session's PR stack first (agent
 * "main"), then each fleet node that has opened or linked its own PR. Deduped
 * by PR number — a child PR equal to a main PR number only shows once, as the
 * main row, since that's the row the "main" state tracking already covers.
 */
export const sessionPrRows = (
  mainPrNumbers: readonly number[],
  fleet: readonly SubagentFleetNode[],
  repoByNumber: ReadonlyMap<number, string> = new Map()
): SessionPrRow[] => {
  const seen = new Set<number>()
  const rows: SessionPrRow[] = []
  for (const number of mainPrNumbers) {
    if (seen.has(number)) continue
    seen.add(number)
    const repo = repoByNumber.get(number)
    rows.push({ number, agent: "main", branch: null, ...(repo === undefined ? {} : { repo }) })
  }
  for (const node of fleet) {
    if (node.prNumber == null || seen.has(node.prNumber)) continue
    seen.add(node.prNumber)
    rows.push({
      number: node.prNumber,
      agent: node.agent,
      branch: node.workspace?.branch ?? null,
      state: node.status,
      nodeId: node.id
    })
  }
  return rows
}
