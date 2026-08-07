/** Thin React binding for session-scoped Preview dock state. */
import { useCallback, useEffect, useMemo } from "react"
import { useMachine } from "@xstate/react"
import type { DockSide } from "@jingler/ui"
import {
  previewDockMachine,
  previewSessionState,
  type PreviewSessionState
} from "./preview-dock-machine.js"

export interface PreviewDockSessionPrefs extends PreviewSessionState {
  readonly toggle: () => void
  readonly navigate: (url: string) => void
}

export interface PreviewDockPrefs {
  readonly visible: boolean
  readonly toggle: () => void
  readonly side: DockSide
  readonly setSide: (side: DockSide) => void
  readonly focusSession: (sessionId: string | null) => void
  readonly removeSession: (sessionId: string) => void
  readonly reconcileSessions: (sessionIds: ReadonlyArray<string>) => void
  readonly forSession: (sessionId: string | null) => PreviewDockSessionPrefs
}

export function usePreviewDock(): PreviewDockPrefs {
  const [state, send] = useMachine(previewDockMachine)
  const focusedSessionId = state.context.focusedSessionId
  const focused = previewSessionState(state.context, focusedSessionId)
  const toggle = useCallback(() => send({ type: "TOGGLE" }), [send])
  const setSide = useCallback(
    (side: DockSide) => send({ type: "SET_SIDE", side }),
    [send]
  )
  const focusSession = useCallback(
    (sessionId: string | null) => send({ type: "FOCUS_SESSION", sessionId }),
    [send]
  )
  const removeSession = useCallback(
    (sessionId: string) => send({ type: "REMOVE_SESSION", sessionId }),
    [send]
  )
  const reconcileSessions = useCallback(
    (sessionIds: ReadonlyArray<string>) => send({ type: "RECONCILE_SESSIONS", sessionIds }),
    [send]
  )
  const forSession = useCallback(
    (sessionId: string | null): PreviewDockSessionPrefs => {
      const session = previewSessionState(state.context, sessionId)
      return {
        ...session,
        toggle: () => {
          if (sessionId !== null) send({ type: "TOGGLE", sessionId })
        },
        navigate: (url) => {
          if (sessionId !== null) send({ type: "NAVIGATE", sessionId, url })
        }
      }
    },
    [send, state.context]
  )

  useEffect(() => {
    const stopReveal = window.jingler.onPreviewReveal(({ sessionId, url }) => {
      send({ type: "REVEAL_BROWSER", sessionId, url })
    })
    const stopUrl = window.jingler.onPreviewUrlChanged(({ sessionId, url }) => {
      send({ type: "NATIVE_URL", sessionId, url })
    })
    return () => {
      stopReveal()
      stopUrl()
    }
  }, [send])

  return useMemo(
    () => ({
      visible: focused.visible,
      toggle,
      side: state.context.side,
      setSide,
      focusSession,
      removeSession,
      reconcileSessions,
      forSession
    }),
    [
      focused.visible,
      focusSession,
      forSession,
      reconcileSessions,
      removeSession,
      setSide,
      state.context.side,
      toggle
    ]
  )
}
