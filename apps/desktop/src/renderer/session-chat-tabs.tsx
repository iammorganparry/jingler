import type { Session, SubagentFleetNode } from "@jingler/core"
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

export function SessionSubagentTabs({
  session,
  onSelectConversation
}: {
  readonly session: Session
  readonly onSelectConversation: () => void
}) {
  const snapshots = useSessionSubagentTabs(session.id)
  const active = snapshots.find(({ chatId }) => chatId === session.activeChatId)
  return (
    <SubagentChip
      subagents={[...(active?.active ?? []), ...(active?.completed ?? [])].map(chipItem)}
      onOpenSubagent={(nodeId) => {
        onSelectConversation()
        selectSubagentTab(session.id, session.activeChatId, nodeId)
      }}
    />
  )
}
