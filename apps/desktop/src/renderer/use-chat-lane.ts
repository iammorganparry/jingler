/** Thin React binding for the chat lane machine: content-open and window-width in, layout props out. */
import { useCallback, useEffect, useMemo } from "react"
import { useMachine } from "@xstate/react"
import { chatLaneMachine, chatLaneView, type ChatLaneView } from "./chat-lane-machine.js"

export interface ChatLane extends ChatLaneView {
  readonly toggleCollapse: () => void
  readonly toggleFocus: () => void
  readonly resize: (width: number) => void
  readonly resetWidth: () => void
}

export function useChatLane(contentOpen: boolean): ChatLane {
  const [state, send] = useMachine(chatLaneMachine, {
    input: { windowWidth: window.innerWidth, contentOpen }
  })

  useEffect(() => {
    send({ type: contentOpen ? "OPEN_CONTENT" : "CLOSE_CONTENT" })
  }, [contentOpen, send])

  useEffect(() => {
    const onResize = () => send({ type: "WINDOW_RESIZE", width: window.innerWidth })
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [send])

  const toggleCollapse = useCallback(() => send({ type: "TOGGLE_COLLAPSE" }), [send])
  const toggleFocus = useCallback(() => send({ type: "TOGGLE_FOCUS" }), [send])
  const resize = useCallback((width: number) => send({ type: "RESIZE", width }), [send])
  const resetWidth = useCallback(() => send({ type: "RESET_WIDTH" }), [send])

  return useMemo(
    () => ({ ...chatLaneView(state), toggleCollapse, toggleFocus, resize, resetWidth }),
    [state, toggleCollapse, toggleFocus, resize, resetWidth]
  )
}
