import type { Session, SubagentFleetNode } from "@jingler/core"
import { useMemo } from "react"
import { SubagentChip, type SubagentChipItem, type SubagentChipStatus } from "@jingler/ui"
import { selectSubagentTab, useSessionSubagentTabs } from "./subagent-tab-store.js"

const chipStatus = (status: SubagentFleetNode["status"]): SubagentChipStatus =>
  status === "queued" ? "spawning" : status === "needs-attention" ? "attention" : status === "unknown" ? "stopped" : status

const chipItem = (node: SubagentFleetNode): SubagentChipItem => ({
  id: node.id,
  agent: node.agent,
  task: node.task,
  status: chipStatus(node.status),
  startedAt: node.startedAt,
  ...(node.completedAt === null ? {} : { endedAt: node.completedAt })
})

/** The active chat's children as chip items, plus the open callback shared by every entry point. */
export function useSessionSubagentEntry(session: Session) {
  const snapshots = useSessionSubagentTabs(session.id)
  return useMemo(() => {
    const active = snapshots.find(({ chatId }) => chatId === session.activeChatId)
    return {
      subagents: [...(active?.active ?? []), ...(active?.completed ?? [])].map(chipItem),
      onOpenSubagent: (nodeId: string) => selectSubagentTab(session.id, session.activeChatId, nodeId)
    }
  }, [snapshots, session.id, session.activeChatId])
}

export function SessionSubagentTabs({
  session,
  onSelectConversation
}: {
  readonly session: Session
  readonly onSelectConversation: () => void
}) {
  const { subagents, onOpenSubagent } = useSessionSubagentEntry(session)
  return (
    <SubagentChip
      subagents={subagents}
      onOpenSubagent={(nodeId) => {
        onSelectConversation()
        onOpenSubagent(nodeId)
      }}
    />
  )
}
