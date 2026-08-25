/** Thin React binding for session-scoped Preview dock state. */
import { useCallback, useEffect, useMemo } from "react"
import { useMachine } from "@xstate/react"
import type { DockSide } from "@jingler/ui"
import {
  previewDockMachine,
  previewOwnerId,
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
  readonly focusAgent: (sessionId: string | null, chatId: string | null) => void
  readonly removeSession: (sessionId: string) => void
  readonly reconcileSessions: (sessionIds: ReadonlyArray<string>) => void
  readonly forAgent: (sessionId: string | null, chatId: string | null) => PreviewDockSessionPrefs
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
  const focusAgent = useCallback(
    (sessionId: string | null, chatId: string | null) => send({
      type: "FOCUS_SESSION",
      sessionId: sessionId === null || chatId === null ? null : previewOwnerId(sessionId, chatId)
    }),
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
  const forAgent = useCallback(
    (sessionId: string | null, chatId: string | null): PreviewDockSessionPrefs => {
      const ownerId = sessionId === null || chatId === null ? null : previewOwnerId(sessionId, chatId)
      const session = previewSessionState(state.context, ownerId)
      return {
        ...session,
        toggle: () => {
          if (ownerId !== null) send({ type: "TOGGLE", sessionId: ownerId })
        },
        navigate: (url) => {
          if (ownerId !== null) send({ type: "NAVIGATE", sessionId: ownerId, url })
        }
      }
    },
    [send, state.context]
  )

  useEffect(() => {
    const stopReveal = window.jingler.onPreviewReveal(({ sessionId, chatId, url }) => {
      send({ type: "REVEAL_BROWSER", sessionId: previewOwnerId(sessionId, chatId), url })
    })
    const stopUrl = window.jingler.onPreviewUrlChanged(({ sessionId, chatId, url }) => {
      send({ type: "NATIVE_URL", sessionId: previewOwnerId(sessionId, chatId), url })
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
      focusAgent,
      removeSession,
      reconcileSessions,
      forAgent
    }),
    [
      focused.visible,
      focusAgent,
      forAgent,
      reconcileSessions,
      removeSession,
      setSide,
      state.context.side,
      toggle
    ]
  )
}
