import type { Session, SubagentFleetNode } from "@jingler/core"
import { useCallback, useMemo, type ReactNode } from "react"
import {
  FollowAgentToggle,
  SubagentChip,
  SubagentLaneViewContext,
  type ChatLaneHeaderSubagentView,
  type SubagentChipItem,
  type SubagentChipStatus
} from "@jingler/ui"
import { useAgentRoster } from "./agent-roster.js"
import { rpc } from "./rpc-client.js"
import { useFileBrowser } from "./use-file-browser.js"
import {
  selectSubagentTab,
  subagentViewActor,
  useAllSessionSubagentTabs,
  useSessionSubagentTabs,
  useSubagentViewSelections
} from "./subagent-tab-store.js"

const chipStatus = (status: SubagentFleetNode["status"]): SubagentChipStatus =>
  status === "queued" ? "spawning" : status === "needs-attention" ? "attention" : status === "unknown" ? "stopped" : status

const chipItem = (node: SubagentFleetNode): SubagentChipItem => ({
  id: node.id,
  agent: node.agent,
  task: node.task,
  status: chipStatus(node.status),
  parentId: node.parentId,
  startedAt: node.startedAt,
  ...(node.completedAt === null ? {} : { endedAt: node.completedAt }),
  branch: node.workspace?.branch ?? null,
  ...(node.workspace?.diff ? { diff: node.workspace.diff } : {}),
  prNumber: node.prNumber
})

/** The active chat's children as chip items, plus the open callback shared by every entry point. */
export function useSessionSubagentEntry(session: Session) {
  const snapshots = useSessionSubagentTabs(session.id)
  return useMemo(() => {
    const active = snapshots.find(({ chatId }) => chatId === session.activeChatId)
    return {
      subagents: [...(active?.orchestrators ?? []), ...(active?.active ?? []), ...(active?.completed ?? [])].map(chipItem),
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
  const peers = useAgentRoster(session).filter((agent) => agent.chatId !== session.activeChatId)
  const inSubagentView = useSubagentViewSelections()[session.activeChatId] !== undefined
  // Same session follow state as the composer toggle (one file-browser actor per session).
  const fileBrowser = useFileBrowser(session.id, session.worktreePath)
  return (
    <>
    {inSubagentView && (
      <FollowAgentToggle
        followAgent={fileBrowser.followEnabled}
        onToggleFollowAgent={(enabled) => (enabled ? fileBrowser.enableFollow() : fileBrowser.disableFollow())}
      />
    )}
    <SubagentChip
      subagents={subagents}
      peers={peers}
      onMessagePeer={(toChatId, text) => rpc.agentMessagePeer(session.id, session.activeChatId, toChatId, text)}
      onOpenSubagent={(nodeId) => {
        onSelectConversation()
        onOpenSubagent(nodeId)
      }}
    />
    </>
  )
}

/** Feeds every chat lane header its breadcrumb while a subagent is swapped into that lane. */
export function SubagentLaneViewProvider({ children }: { readonly children: ReactNode }) {
  const selections = useSubagentViewSelections()
  const tabs = useAllSessionSubagentTabs()
  const resolve = useCallback(
    (chatId: string): ChatLaneHeaderSubagentView | null => {
      const selectedId = selections[chatId]
      if (selectedId === undefined) return null
      const snapshot = Object.values(tabs).flat().find((tab) => tab.chatId === chatId)
      const actor = subagentViewActor(chatId)
      return {
        selectedId,
        siblings: [...(snapshot?.active ?? []), ...(snapshot?.completed ?? [])].map(
          ({ id, agent, task }) => ({ id, agent, task })
        ),
        onSwitch: (id) => actor.send({ type: "SWITCH_SIBLING", id }),
        onBack: () => actor.send({ type: "BACK" })
      }
    },
    [selections, tabs]
  )
  return <SubagentLaneViewContext.Provider value={resolve}>{children}</SubagentLaneViewContext.Provider>
}
