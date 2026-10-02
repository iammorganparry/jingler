import type { Session } from "@jingler/core"
import { SubagentTabBar } from "@jingler/ui"
import { selectSubagentTab, useSessionSubagentTabs } from "./subagent-tab-store.js"

export function SessionSubagentTabs({
  session,
  filesActive = false,
  onSelectConversation
}: {
  readonly session: Session
  readonly filesActive?: boolean
  readonly onSelectConversation: () => void
}) {
  const snapshots = useSessionSubagentTabs(session.id)
  const active = snapshots.find(({ chatId }) => chatId === session.activeChatId)
  const subagents = active?.active ?? []
  return (
    <SubagentTabBar
      previous={(active?.completed ?? []).map((node) => ({ id: node.id, title: `${node.agent} · ${node.task}` }))}
      onOpenPrevious={(nodeId) => {
        onSelectConversation()
        selectSubagentTab(session.id, session.activeChatId, nodeId)
      }}
      subagents={subagents.map((node) => ({
        id: node.id,
        title: `${node.agent} · ${node.task}`,
        status: node.status === "needs-attention" ? "attention" : "running"
      }))}
      activeSubagentId={filesActive ? undefined : active?.selectedId}
      onSelectSubagent={(nodeId) => {
        onSelectConversation()
        selectSubagentTab(session.id, session.activeChatId, nodeId)
      }}
    />
  )
}
