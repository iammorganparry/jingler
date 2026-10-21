/** Per-tree Changes: the main checkout plus every subagent that owns a worktree. */
import { useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import type { PrFileChange, Session, SubagentFleetNode } from "@jingler/core"
import type { AgentTreeChanges } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { useSessionSubagentTabs } from "./subagent-tab-store.js"

/** One entry per subagent that has its own workspace, newest registry entry winning. */
export const workspaceNodes = (
  nodes: ReadonlyArray<SubagentFleetNode>
): ReadonlyArray<SubagentFleetNode> => [
  ...new Map(
    nodes.filter((node) => node.workspace !== null).map((node) => [node.subagentId, node])
  ).values()
]

export function useAgentTrees(
  session: Session,
  mainFiles: ReadonlyArray<PrFileChange>,
  enabled: boolean
): ReadonlyArray<AgentTreeChanges> {
  const snapshots = useSessionSubagentTabs(session.id)
  const snapshot = snapshots.find((candidate) => candidate.chatId === session.activeChatId)
  const nodes = useMemo(
    () => workspaceNodes([...(snapshot?.active ?? []), ...(snapshot?.completed ?? [])]),
    [snapshot]
  )
  const diffs = useQueries({
    queries: nodes.map((node) => ({
      queryKey: ["local", "diff", session.id, "workspace", node.workspace!.path],
      queryFn: () => rpc.sessionsDiff(session.id, undefined, node.workspace!.path),
      enabled
    }))
  })
  return useMemo(() => {
    const children = nodes.flatMap((node, index): AgentTreeChanges[] => {
      const files = diffs[index]?.data?.files ?? []
      if (files.length === 0) return []
      return [
        {
          agentId: node.subagentId,
          label: node.task,
          files: files.map((file) => ({
            path: file.path,
            additions: file.added,
            deletions: file.removed,
            commentCount: 0,
            viewed: false
          }))
        }
      ]
    })
    return children.length === 0 ? [] : [{ agentId: null, label: "Main", files: mainFiles }, ...children]
  }, [nodes, diffs, mainFiles])
}
