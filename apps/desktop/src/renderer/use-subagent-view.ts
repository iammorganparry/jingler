/** Thin React binding for a chat lane's in-place subagent swap. */
import { useCallback } from "react"
import { useSelector } from "@xstate/react"
import { subagentViewActor } from "./subagent-tab-store.js"

export interface SubagentViewProps {
  readonly selectedId: string | null
  readonly mainDraft: string
  readonly mainScrollTop: number
  readonly open: (id: string) => void
  readonly switchSibling: (id: string) => void
  readonly back: () => void
  readonly changesScope: string
  readonly setChangesScope: (scope: string) => void
}

export function useSubagentView(chatId: string): SubagentViewProps {
  const actor = subagentViewActor(chatId)
  const { selectedId, mainDraft, mainScrollTop, changesScope } = useSelector(actor, (snapshot) => snapshot.context)
  const open = useCallback((id: string) => actor.send({ type: "OPEN_SUBAGENT", id }), [actor])
  const switchSibling = useCallback((id: string) => actor.send({ type: "SWITCH_SIBLING", id }), [actor])
  const back = useCallback(() => actor.send({ type: "BACK" }), [actor])
  const setChangesScope = useCallback(
    (scope: string) => actor.send({ type: "SET_CHANGES_SCOPE", scope }),
    [actor]
  )
  return { selectedId, mainDraft, mainScrollTop, open, switchSibling, back, changesScope, setChangesScope }
}
