/**
 * PreviewDockView — binds the Preview dock's prefs (`usePreviewDock`), the
 * main-process `WebContentsView` (the `BrowserPreview.*` RPCs) and the asset
 * read path (`Asset.*`) to the presentational `PreviewDock` in @starbase/ui.
 *
 * ## The native view is not in the DOM, and that shapes everything here
 *
 * The browser is an Electron overlay painted over the renderer at a rect this
 * component measures. It does not participate in CSS stacking, so it cannot be
 * hidden by hiding a div: switching to an asset tab has to tell main to hide it
 * explicitly, or it sits on top of the asset. And it must be HIDDEN rather than
 * closed — closing tears down the WebContents, so clicking back to Browser would
 * land on a blank default URL with the page, history and scroll gone.
 *
 * That is why the browser body stays mounted for every tab (the dock renders all
 * bodies and CSS-hides the inactive ones) while `setVisible` and the bounds loop
 * are gated on it actually being on screen.
 *
 * "On screen" is TWO conditions, and both native bodies check both: the tab is
 * focused AND the dock is open. Checking only tab focus leaves the overlay
 * painting over the conversation the moment ⌃⇧B hides the dock — and because the
 * rAF loop deliberately ignores a degenerate rect (`isPaintableRect`) rather than
 * pushing a 0×0 one, it holds its last good bounds and simply stays there until
 * the app restarts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Session } from "@starbase/core"
import {
  AssetError,
  AssetLoading,
  AssetTooLarge,
  AssetUnsupported,
  AssetView,
  BROWSER_TAB_ID,
  PreviewDock,
  type PreviewTab
} from "@starbase/ui"
import { isPaintableRect } from "./browser-preview-bounds.js"
import { rpc } from "./rpc-client.js"
import type { PreviewDockPrefs } from "./use-preview-dock.js"
import { assetTabId } from "./preview-dock-machine.js"

// Default target until run-scripts (#1) can seed the session's real dev-server
// port. TODO(#1): derive from the session's $STARBASE_PORT when available.
const DEFAULT_URL = "http://localhost:3000"

export interface PreviewDockViewProps {
  /** The active session (reserved for future port seeding). Null → none. */
  session: Session | null
  dock: PreviewDockPrefs
}

export function PreviewDockView({ session, dock }: PreviewDockViewProps) {
  const [url, setUrl] = useState(DEFAULT_URL)
  const browsing = dock.activeId === BROWSER_TAB_ID
  // The native view is only wanted when the dock is open AND the Browser tab is
  // the one on screen. Both halves matter: hiding the dock and switching tabs
  // are different gestures that must reach the same overlay.
  const nativeWanted = dock.visible && browsing

  const renderTab = useCallback(
    (tab: PreviewTab, active: boolean) =>
      tab.kind === "browser" ? (
        <BrowserBody url={url} session={session} nativeWanted={nativeWanted} />
      ) : (
        <AssetTab tabId={tab.id} assets={dock.assets} active={active} dockVisible={dock.visible} />
      ),
    [url, session, nativeWanted, dock.assets, dock.visible]
  )

  return (
    <PreviewDock
      dock={dock.side}
      onDockChange={dock.setSide}
      visible={dock.visible}
      onToggle={dock.toggle}
      tabs={dock.tabs}
      activeId={dock.activeId}
      onSelect={dock.select}
      onClose={dock.close}
      url={url}
      onNavigate={setUrl}
      onReload={() => void rpc.browserPreviewReload()}
      renderTab={renderTab}
    />
  )
}

/**
 * The browser tab's body: a measured placeholder the native view is parked over,
 * plus the effects that keep the two in sync.
 */
function BrowserBody({
  url,
  session,
  nativeWanted
}: {
  url: string
  session: Session | null
  nativeWanted: boolean
}) {
  const boundsRef = useRef<HTMLDivElement>(null)

  const rect = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const el = boundsRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, [])

  // The URL last loaded into the native view (via open OR navigate), so a URL
  // change navigates IN PLACE instead of tearing the view down. Held in a ref so
  // it doesn't drive the lifecycle effect below.
  const loadedUrl = useRef<string | null>(null)
  const urlRef = useRef(url)
  useEffect(() => {
    urlRef.current = url
  }, [url])

  // Lifecycle: create the native view the first time the browser tab is shown,
  // and destroy it only on unmount. Deliberately NOT keyed on `url` — navigating
  // must not recreate the view (that would flash a blank overlay).
  useEffect(() => {
    if (!nativeWanted) return
    const r = rect()
    if (!r) return
    if (loadedUrl.current === null) {
      void rpc.browserPreviewOpen(urlRef.current, r).catch(() => {})
      loadedUrl.current = urlRef.current
    }
  }, [nativeWanted, rect])

  useEffect(
    () => () => {
      void rpc.browserPreviewClose()
      loadedUrl.current = null
    },
    []
  )

  // Show/hide rather than open/close on a tab switch. `close()` here would be
  // the bug this dock was built to avoid: the page, its history and its scroll
  // position all live in the WebContents that close() destroys.
  useEffect(() => {
    void rpc.browserPreviewSetVisible(nativeWanted)
  }, [nativeWanted])

  // Navigation: load a new URL on the already-open view (no teardown). Skips the
  // value `open` just loaded, so opening the dock doesn't double-load.
  useEffect(() => {
    if (!nativeWanted || loadedUrl.current === url) return
    loadedUrl.current = url
    void rpc.browserPreviewNavigate(url).catch(() => {})
  }, [nativeWanted, url])

  // Keep the native view aligned with the placeholder: a rAF loop that pushes new
  // bounds only when they change (handles dock resize AND layout shifts that move
  // the pane without resizing it, which a ResizeObserver would miss).
  useEffect(() => {
    if (!nativeWanted) return
    let raf = 0
    let last = ""
    const tick = () => {
      const r = rect()
      // A degenerate rect is NOT a small view — it's a placeholder that is
      // hidden, unmounted, or mid-transition through a dock switch. Pushing one
      // parks a zero-size (or negative) overlay over the placeholder, and
      // Chromium reflows the page to that size on the way through. Skipping
      // holds the last good bounds until the layout settles, one frame later.
      //
      // A SMALL rect is a different thing entirely and must still be pushed —
      // see `isPaintableRect` for what happened when this guard couldn't tell
      // the two apart.
      if (r && isPaintableRect(r)) {
        const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
        if (key !== last) {
          last = key
          void rpc.browserPreviewSetBounds(r)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [nativeWanted, rect])

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
      {/* The native WebContentsView floats over this rect; the label shows through
          until the page paints. `session` is reserved for future port seeding. */}
      <div ref={boundsRef} className="absolute inset-0" data-session={session?.id ?? ""} />
      {empty}
    </>
  )
}

/**
 * An asset tab's body.
 *
 * Fetching is gated on `active` so opening five tabs doesn't read five files —
 * a background tab costs nothing until you look at it. React Query then caches
 * per (session, path), so flipping back to a tab you have already viewed is
 * instant and does not re-read the file.
 */
function AssetTab({
  tabId,
  assets,
  active,
  dockVisible
}: {
  tabId: string
  assets: PreviewDockPrefs["assets"]
  active: boolean
  /** Whether the DOCK itself is showing. A PDF needs both — see `PdfBody`. */
  dockVisible: boolean
}) {
  const asset = assets.find((a) => assetTabId(a.sessionId, a.path) === tabId)
  const query = useQuery({
    queryKey: ["asset", asset?.sessionId, asset?.path],
    queryFn: () => rpc.assetRead(asset?.sessionId ?? "", asset?.path ?? ""),
    enabled: active && asset !== undefined,
    // Agents rewrite files mid-session, so a cached read goes stale the moment
    // the next turn touches it. Refetching on focus is the cheap approximation
    // of a worktree watcher, which is deliberately out of scope for v1.
    refetchOnWindowFocus: true,
    retry: false
  })

  if (!asset) return <AssetError message="This tab's file is no longer open." />
  if (query.isPending) return <AssetLoading />
  if (query.isError) return <AssetFailure error={query.error} asset={asset} />

  const body = <AssetView payload={query.data} onReveal={() => void reveal(asset)} />
  // A PDF is not rendered by React at all — `AssetView` draws a hole and
  // Chromium's own viewer is parked over it, which is why the app ships no
  // pdf.js. The wrapper exists solely to measure that hole.
  return query.data.kind === "pdf" ? (
    // BOTH conditions, for the same reason `BrowserBody` takes `nativeWanted`:
    // a native overlay is not hidden by hiding a div, so the dock closing has to
    // be said out loud exactly as a tab switch does.
    <PdfBody asset={asset} shown={active && dockVisible}>
      {body}
    </PdfBody>
  ) : (
    body
  )
}

/**
 * Parks Chromium's PDF viewer over its placeholder, and takes it away again.
 *
 * Mirrors `BrowserBody`: a native overlay cannot be hidden by hiding a div, so
 * leaving a tab has to say so out loud. The `hidePdf` on cleanup is the whole
 * reason this is a component rather than an effect in `AssetTab` — React runs it
 * on unmount too, so closing the tab can't strand a PDF painted over the app.
 */
function PdfBody({
  asset,
  shown,
  children
}: {
  asset: { sessionId: string; path: string }
  /** The tab is focused AND the dock is open. Either being false hides the view. */
  shown: boolean
  children: React.ReactNode
}) {
  const boundsRef = useRef<HTMLDivElement>(null)

  const rect = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const el = boundsRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, [])

  useEffect(() => {
    if (!shown) {
      void rpc.assetHidePdf()
      return
    }
    const r = rect()
    if (r && isPaintableRect(r)) {
      void rpc.assetOpenPdf(asset.sessionId, asset.path, r).catch(() => {})
    }
    return () => {
      void rpc.assetHidePdf()
    }
  }, [shown, asset.sessionId, asset.path, rect])

  // Same rAF discipline as the browser: push bounds only when they change, and
  // never push a degenerate rect (see `isPaintableRect`).
  useEffect(() => {
    if (!shown) return
    let raf = 0
    let last = ""
    const tick = () => {
      const r = rect()
      if (r && isPaintableRect(r)) {
        const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
        if (key !== last) {
          last = key
          void rpc.browserPreviewSetBounds(r)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [shown, rect])

  return (
    <div ref={boundsRef} className="absolute inset-0">
      {children}
    </div>
  )
}

const reveal = (asset: { sessionId: string; path: string }) =>
  rpc.assetReveal(asset.sessionId, asset.path).catch(() => {})

/**
 * Turn a decoded RPC failure back into the right viewer state.
 *
 * The errors arrive as tagged values across the RPC boundary, so this switches
 * on `_tag` rather than sniffing a message string — a rename in
 * `packages/core/src/errors.ts` then fails the build instead of silently
 * degrading every over-cap file to a generic "something went wrong".
 */
function AssetFailure({ error, asset }: { error: unknown; asset: { sessionId: string; path: string } }) {
  const onReveal = () => void reveal(asset)
  const tagged = error as { _tag?: string; size?: number; cap?: number }
  switch (tagged._tag) {
    case "AssetTooLargeError":
      return (
        <AssetTooLarge
          path={asset.path}
          size={tagged.size ?? 0}
          cap={tagged.cap ?? 0}
          onReveal={onReveal}
        />
      )
    case "AssetUnsupportedError":
      return <AssetUnsupported path={asset.path} onReveal={onReveal} />
    default:
      return <AssetError message={`Couldn't open ${asset.path}.`} onReveal={onReveal} />
  }
}
