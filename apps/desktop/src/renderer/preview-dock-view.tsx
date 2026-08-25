/** Browser-only Preview dock binding. Repository files live in the Files tab. */
import { useEffect, useMemo, useRef } from "react"
import type { Session } from "@jingler/core"
import { PreviewDock, useHasNativeEclipsingOverlay } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import type { PreviewDockPrefs, PreviewDockSessionPrefs } from "./use-preview-dock.js"
import { useNativeViewBounds } from "./use-native-view-bounds.js"

export interface PreviewDockViewProps {
  readonly session: Session | null
  readonly dock: PreviewDockPrefs
}

export function PreviewDockView({ session, dock }: PreviewDockViewProps) {
  const sessionId = session?.id ?? null
  const chatId = session?.activeChatId ?? null
  const browser = dock.forAgent(sessionId, chatId)

  return (
    <PreviewDock
      embedded
      dock={dock.side}
      onDockChange={dock.setSide}
      visible={browser.visible}
      onToggle={browser.toggle}
      url={browser.url}
      onNavigate={browser.navigate}
      onReload={() => {
        if (session !== null) void rpc.browserPreviewReload(session.id, session.activeChatId)
      }}
      renderBrowser={(active) => (
        <BrowserBody
          // Each session tab owns its own measurement surface and native view.
          key={sessionId === null || chatId === null ? "no-agent" : `${sessionId}:${chatId}`}
          browser={browser}
          sessionId={sessionId}
          chatId={chatId}
          nativeWanted={active && sessionId !== null}
        />
      )}
    />
  )
}

function BrowserBody({
  browser,
  sessionId,
  chatId,
  nativeWanted
}: {
  readonly browser: PreviewDockSessionPrefs
  readonly sessionId: string | null
  readonly chatId: string | null
  readonly nativeWanted: boolean
}) {
  const { url } = browser
  const loadedUrls = useRef(new Map<string, string>())
  const urlRef = useRef(url)
  useEffect(() => {
    urlRef.current = url
  }, [url])
  // The native WebContentsView composites ABOVE all renderer DOM, so an open
  // dialog would otherwise render underneath the page it's asking about. Hide
  // the native view while any registered overlay is open; it restores on close.
  const overlayOpen = useHasNativeEclipsingOverlay()
  const nativeVisible = nativeWanted && !overlayOpen

  const boundsRef = useNativeViewBounds({
    active: nativeWanted,
    onFirstPaintableRect: (rect) => {
      if (sessionId !== null && chatId !== null) {
        void rpc.browserPreviewOpen(sessionId, chatId, urlRef.current, rect).catch(() => {})
        loadedUrls.current.set(`${sessionId}:${chatId}`, urlRef.current)
      }
    },
    onBoundsChanged: (rect) => {
      if (sessionId !== null && chatId !== null) void rpc.browserPreviewSetBounds(sessionId, chatId, rect)
    }
  })

  useEffect(() => {
    if (sessionId === null || chatId === null) return
    return () => {
      void rpc.browserPreviewSetVisible(sessionId, chatId, false)
    }
  }, [chatId, sessionId])

  useEffect(() => {
    if (sessionId !== null && chatId !== null) void rpc.browserPreviewSetVisible(sessionId, chatId, nativeVisible)
  }, [chatId, nativeVisible, sessionId])

  useEffect(() => {
    if (
      sessionId === null ||
      chatId === null ||
      !nativeWanted ||
      !loadedUrls.current.has(`${sessionId}:${chatId}`) ||
      loadedUrls.current.get(`${sessionId}:${chatId}`) === url
    ) return
    loadedUrls.current.set(`${sessionId}:${chatId}`, url)
    if (browser.source === "native") return
    if (sessionId !== null) void rpc.browserPreviewNavigate(sessionId, chatId, url).catch(() => {})
  }, [browser.source, chatId, nativeWanted, sessionId, url])

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
