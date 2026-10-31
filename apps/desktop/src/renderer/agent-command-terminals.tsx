import { useEffect, useMemo } from "react"
import { useSelector } from "@xstate/react"
import type { Session } from "@jingler/core"
import { getConversationActor } from "./conversation-registry.js"
import { XtermView } from "./xterm-view.js"
import { findToolCall, markDone, type AgentCommandTab } from "./agent-command-tabs.js"

export function AgentCommandView({ session, tab, active }: { session: Session; tab: AgentCommandTab; active: boolean }) {
  // Memoised: getConversationActor pushes the session into the actor on every call.
  const actor = useMemo(() => getConversationActor(session, tab.chatId), [session.id, tab.chatId]) // eslint-disable-line react-hooks/exhaustive-deps
  const tool = useSelector(actor, (snapshot) => findToolCall(snapshot.context, tab.toolId))
  const status = tool?.status ?? null
  useEffect(() => {
    if (status !== null && status !== "running") markDone(session.id, tab.id)
  }, [session.id, status, tab.id])
  return <XtermView terminalId={tab.id} active={active} mirror={{ output: tool?.output, status }} />
}
