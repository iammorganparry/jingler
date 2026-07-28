/**
 * usePreviewDock — the React binding for `previewDockMachine`.
 *
 * All the rules (what persists, what shows the dock, what the pinned browser tab
 * is for) live in the machine; this file only turns a snapshot into the props
 * the dock's views want and forwards intents as events. The one thing that
 * genuinely belongs here is the global ⌃⇧B listener — a DOM subscription, not
 * dock state.
 */
import { useCallback, useEffect, useMemo } from "react"
import { useMachine } from "@xstate/react"
import type { DockSide, PreviewTab } from "@jingler/ui"
import { BROWSER_TAB_ID } from "@jingler/ui"
import { assetTabId, type OpenAsset, previewDockMachine } from "./preview-dock-machine.js"

const basename = (path: string): string => path.split("/").pop() ?? path

export interface PreviewDockPrefs {
  visible: boolean
  toggle: () => void
  side: DockSide
  setSide: (side: DockSide) => void
  /** The pinned browser tab followed by one tab per open asset, in open order. */
  tabs: ReadonlyArray<PreviewTab>
  /** The open assets, for the app to read contents for. Parallel to `tabs`. */
  assets: ReadonlyArray<OpenAsset>
  activeId: string
  select: (id: string) => void
  /** Open (or focus) an asset, showing the dock if it was hidden. */
  openAsset: (sessionId: string, path: string) => void
  /** Close an asset tab. A no-op for the pinned browser tab. */
  close: (id: string) => void
  /**
   * Drop tabs whose session is no longer live, reconciling against the given
   * set of live session ids. A no-op when the set is empty (sessions not loaded
   * yet), so a slow first load never wipes restored tabs.
   */
  pruneTabs: (liveSessionIds: ReadonlySet<string>) => void
}

export function usePreviewDock(): PreviewDockPrefs {
  const [state, send] = useMachine(previewDockMachine)
  const { side, assets, activeId } = state.context

  const toggle = useCallback(() => send({ type: "TOGGLE" }), [send])
  const setSide = useCallback((next: DockSide) => send({ type: "SET_SIDE", side: next }), [send])
  const select = useCallback((id: string) => send({ type: "SELECT", id }), [send])
  const close = useCallback((id: string) => send({ type: "CLOSE", id }), [send])
  const pruneTabs = useCallback(
    (liveSessionIds: ReadonlySet<string>) => send({ type: "PRUNE", liveSessionIds }),
    [send]
  )
  const openAsset = useCallback(
    (sessionId: string, path: string) => send({ type: "OPEN_ASSET", sessionId, path }),
    [send]
  )

  const tabs = useMemo<ReadonlyArray<PreviewTab>>(
    () => [
      { id: BROWSER_TAB_ID, kind: "browser", title: "Browser" },
      ...assets.map(
        (a): PreviewTab => ({
          id: assetTabId(a.sessionId, a.path),
          kind: "asset",
          title: basename(a.path),
          path: a.path
        })
      )
    ],
    [assets]
  )

  // Global ⌃⇧B toggles the dock (avoids clashing with the terminal's ⌃`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === "B" || e.code === "KeyB")) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  // Main pushes this on every BrowserControl op (an agent QA-ing a preview URL):
  // open the dock and focus the Browser tab so the operator watches it happen.
  // Idempotent when already shown; re-opens if the operator had closed it, which
  // during active agent QA is the wanted behaviour, not a fight.
  useEffect(() => {
    return window.jingler.onPreviewReveal(() => send({ type: "REVEAL_BROWSER" }))
  }, [send])

  return {
    visible: state.matches("shown"),
    toggle,
    side,
    setSide,
    tabs,
    assets,
    activeId,
    select,
    openAsset,
    close,
    pruneTabs
  }
}
