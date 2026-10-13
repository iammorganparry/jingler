/** Thin React binding for a chat lane's in-place subagent swap. */
import { useCallback } from "react"
import { useMachine } from "@xstate/react"
import { subagentViewMachine } from "./subagent-view-machine.js"

export interface SubagentViewProps {
  readonly selectedId: string | null
  readonly mainDraft: string
  readonly mainScrollTop: number
  readonly open: (id: string) => void
  readonly switchSibling: (id: string) => void
  readonly back: () => void
  readonly saveMainView: (draft: string, scrollTop: number) => void
}

export function useSubagentView(chatId: string): SubagentViewProps {
  const [state, send] = useMachine(subagentViewMachine, { input: { chatId } })
  const open = useCallback((id: string) => send({ type: "OPEN_SUBAGENT", id }), [send])
  const switchSibling = useCallback((id: string) => send({ type: "SWITCH_SIBLING", id }), [send])
  const back = useCallback(() => send({ type: "BACK" }), [send])
  const saveMainView = useCallback(
    (draft: string, scrollTop: number) => send({ type: "SAVE_MAIN_VIEW", draft, scrollTop }),
    [send]
  )
  const { selectedId, mainDraft, mainScrollTop } = state.context
  return { selectedId, mainDraft, mainScrollTop, open, switchSibling, back, saveMainView }
}
