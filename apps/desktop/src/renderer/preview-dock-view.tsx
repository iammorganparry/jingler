/** Browser-only Preview dock binding. Repository files live in the Files tab. */
import { useEffect, useMemo, useRef } from "react"
import type { Session } from "@jingler/core"
import { PreviewDock } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import type { PreviewDockPrefs, PreviewDockSessionPrefs } from "./use-preview-dock.js"
import { useNativeViewBounds } from "./use-native-view-bounds.js"

export interface PreviewDockViewProps {
  readonly session: Session | null
  readonly dock: PreviewDockPrefs
}

export function PreviewDockView({ session, dock }: PreviewDockViewProps) {
  const sessionId = session?.id ?? null
  const browser = dock.forSession(sessionId)

  useEffect(() => {
    dock.focusSession(sessionId)
  }, [dock.focusSession, sessionId])

  return (
    <PreviewDock
      dock={dock.side}
      onDockChange={dock.setSide}
      visible={browser.visible}
      onToggle={browser.toggle}
      url={browser.url}
      onNavigate={browser.navigate}
      onReload={() => {
        if (session !== null) void rpc.browserPreviewReload(session.id)
      }}
      renderBrowser={(active) => (
        <BrowserBody
          // Re-arm first-paint measurement when focus moves directly between
          // two already-visible docks. The native views remain alive in main;
          // only this renderer-side bounds owner is session-specific.
          key={sessionId ?? "no-session"}
          browser={browser}
          sessionId={sessionId}
          nativeWanted={active && sessionId !== null}
        />
      )}
    />
  )
}

function BrowserBody({
  browser,
  sessionId,
  nativeWanted
}: {
  readonly browser: PreviewDockSessionPrefs
  readonly sessionId: string | null
  readonly nativeWanted: boolean
}) {
  const { url } = browser
  const loadedUrls = useRef(new Map<string, string>())
  const urlRef = useRef(url)
  useEffect(() => {
    urlRef.current = url
  }, [url])

  const boundsRef = useNativeViewBounds({
    active: nativeWanted,
    onFirstPaintableRect: (rect) => {
      if (sessionId !== null) {
        void rpc.browserPreviewOpen(sessionId, urlRef.current, rect).catch(() => {})
        loadedUrls.current.set(sessionId, urlRef.current)
      }
    },
    onBoundsChanged: (rect) => {
      if (sessionId !== null) void rpc.browserPreviewSetBounds(sessionId, rect)
    }
  })

  useEffect(() => {
    if (sessionId === null) return
    return () => {
      void rpc.browserPreviewSetVisible(sessionId, false)
    }
  }, [sessionId])

  useEffect(() => {
    if (sessionId !== null) void rpc.browserPreviewSetVisible(sessionId, nativeWanted)
  }, [nativeWanted, sessionId])

  useEffect(() => {
    if (
      sessionId === null ||
      !nativeWanted ||
      !loadedUrls.current.has(sessionId) ||
      loadedUrls.current.get(sessionId) === url
    ) return
    loadedUrls.current.set(sessionId, url)
    if (browser.source === "native") return
    if (sessionId !== null) void rpc.browserPreviewNavigate(sessionId, url).catch(() => {})
  }, [browser.source, nativeWanted, sessionId, url])

  const empty = useMemo(
    () => (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-dim">
        Loading {url}…
      </div>
    ),
    [url]
  )

  return (
    <>
      <div ref={boundsRef} className="absolute inset-0" data-session={sessionId ?? ""} />
      {empty}
    </>
  )
}
