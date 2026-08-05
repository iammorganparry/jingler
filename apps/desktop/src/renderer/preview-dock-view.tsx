/**
 * PreviewDockView — binds the Preview dock's prefs (`usePreviewDock`), the
 * main-process `WebContentsView` (the `BrowserPreview.*` RPCs) and the asset
 * read path (`Asset.*`) to the presentational `PreviewDock` in @jingler/ui.
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Cause, Option, Runtime } from "effect"
import type { Session } from "@jingler/core"
import {
  AssetBrowser,
  AssetCanvas,
  AssetError,
  BROWSER_TAB_ID,
  PreviewDock,
  parsePierreFileDiffForPath,
  type AssetCanvasError,
  type PreviewTab
} from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import type { PreviewDockPrefs } from "./use-preview-dock.js"
import { assetTabId } from "./preview-dock-machine.js"
import { useNativeViewBounds } from "./use-native-view-bounds.js"

// Default target until run-scripts (#1) can seed the session's real dev-server
// port. TODO(#1): derive from the session's $JINGLER_PORT when available.
const DEFAULT_URL = "http://localhost:3000"

export interface PreviewDockViewProps {
  /** The active session (reserved for future port seeding). Null → none. */
  session: Session | null
  dock: PreviewDockPrefs
}

interface BrowserNavigation {
  readonly url: string
  readonly source: "operator" | "native"
}

export function PreviewDockView({ session, dock }: PreviewDockViewProps) {
  const [navigation, setNavigation] = useState<BrowserNavigation>({
    url: DEFAULT_URL,
    source: "operator"
  })
  const { url } = navigation
  // Main owns the native WebContents URL. Agent reveals update immediately with
  // the requested/current URL; committed navigation events then correct it for
  // redirects, clicks, and History API changes. Native updates are state sync,
  // not navigation intents, so BrowserBody must not issue another RPC for them.
  useEffect(() => {
    const syncNativeUrl = (nativeUrl: string) => {
      if (nativeUrl.length > 0) {
        setNavigation({ url: nativeUrl, source: "native" })
      }
    }
    const stopReveal = window.jingler.onPreviewReveal(syncNativeUrl)
    const stopUrlChanged = window.jingler.onPreviewUrlChanged(syncNativeUrl)
    return () => {
      stopReveal()
      stopUrlChanged()
    }
  }, [])
  const browsing = dock.activeId === BROWSER_TAB_ID
  // The native view is only wanted when the dock is open AND the Browser tab is
  // the one on screen. Both halves matter: hiding the dock and switching tabs
  // are different gestures that must reach the same overlay.
  const nativeWanted = dock.visible && browsing

  const renderTab = useCallback(
    (tab: PreviewTab) =>
      tab.kind === "browser" ? (
        <BrowserBody navigation={navigation} session={session} nativeWanted={nativeWanted} />
      ) : null,
    [navigation, session, nativeWanted]
  )
  const renderAssetManager = useCallback(
    (activeTab: PreviewTab | null) => (
      <AssetManagers
        activeId={activeTab?.id ?? null}
        assets={dock.assets}
        dockVisible={dock.visible}
        onOpenAsset={dock.openAsset}
      />
    ),
    [dock.assets, dock.openAsset, dock.visible]
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
      onNavigate={(nextUrl) => setNavigation({ url: nextUrl, source: "operator" })}
      onReload={() => void rpc.browserPreviewReload()}
      renderTab={renderTab}
      renderAssetManager={renderAssetManager}
    />
  )
}

/**
 * The browser tab's body: a measured placeholder the native view is parked over,
 * plus the effects that keep the two in sync.
 */
function BrowserBody({
  navigation,
  session,
  nativeWanted
}: {
  navigation: BrowserNavigation
  session: Session | null
  nativeWanted: boolean
}) {
  const { url } = navigation
  // The URL last loaded into the native view (via open OR navigate), so a URL
  // change navigates IN PLACE instead of tearing the view down. Held in a ref so
  // it doesn't drive the lifecycle effects below.
  const loadedUrl = useRef<string | null>(null)
  const urlRef = useRef(url)
  useEffect(() => {
    urlRef.current = url
  }, [url])

  // Create the native view the first time a paintable rect exists (not on mount:
  // a 0×0 placeholder mid dock-transition would leave the overlay unopened), and
  // keep it aligned after. Idempotent on re-show — the `loadedUrl` guard means a
  // second first-paintable-rect fire doesn't re-open the already-open view.
  const boundsRef = useNativeViewBounds({
    active: nativeWanted,
    onFirstPaintableRect: (r) => {
      if (loadedUrl.current === null) {
        void rpc.browserPreviewOpen(urlRef.current, r).catch(() => {})
        loadedUrl.current = urlRef.current
      }
    },
    onBoundsChanged: (r) => {
      void rpc.browserPreviewSetBounds(r)
    }
  })

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

  // Navigation: load a new URL on the already-open view (no teardown). Guarded on
  // `loadedUrl` being set — before the view opens, the open above loads the
  // current URL, so navigating here would fire against a view that isn't up and
  // block that open (its `loadedUrl === null` guard).
  useEffect(() => {
    if (!nativeWanted || loadedUrl.current === null || loadedUrl.current === url) return
    loadedUrl.current = url
    if (navigation.source === "native") return
    void rpc.browserPreviewNavigate(url).catch(() => {})
  }, [nativeWanted, navigation, url])

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

/** One mounted browser per session keeps its Pierre model alive across tab changes. */
function AssetManagers({
  activeId,
  assets,
  dockVisible,
  onOpenAsset
}: {
  activeId: string | null
  assets: PreviewDockPrefs["assets"]
  dockVisible: boolean
  onOpenAsset: PreviewDockPrefs["openAsset"]
}) {
  const sessionIds = [...new Set(assets.map((asset) => asset.sessionId))]
  const activeAsset = assets.find(
    (asset) => assetTabId(asset.sessionId, asset.path) === activeId
  )
  if (sessionIds.length === 0) {
    return <AssetError message="This tab's file is no longer open." />
  }

  return sessionIds.map((sessionId) => {
    const active = activeAsset?.sessionId === sessionId
    return (
      <div
        key={sessionId}
        className={active ? "absolute inset-0 block" : "absolute inset-0 hidden"}
      >
        <AssetSessionBrowser
          sessionId={sessionId}
          selectedPath={active ? (activeAsset?.path ?? null) : null}
          active={active}
          dockVisible={dockVisible}
          onOpenAsset={onOpenAsset}
        />
      </div>
    )
  })
}

function AssetSessionBrowser({
  sessionId,
  selectedPath,
  active,
  dockVisible,
  onOpenAsset
}: {
  sessionId: string
  selectedPath: string | null
  active: boolean
  dockVisible: boolean
  onOpenAsset: PreviewDockPrefs["openAsset"]
}) {
  const rememberedPath = useRef<string | null>(selectedPath)
  if (selectedPath !== null) rememberedPath.current = selectedPath
  const path = selectedPath ?? rememberedPath.current
  const listQuery = useQuery({
    queryKey: ["asset-list", sessionId],
    queryFn: () => rpc.assetList(sessionId),
    enabled: active && dockVisible,
    refetchOnWindowFocus: false,
    retry: false
  })
  const listedForPath = useRef(path)
  useEffect(() => {
    if (path === null || path === listedForPath.current) return
    listedForPath.current = path
    if (active && dockVisible) void listQuery.refetch()
  }, [active, dockVisible, listQuery.refetch, path])
  const assetQuery = useQuery({
    queryKey: ["asset", sessionId, path],
    queryFn: () => rpc.assetRead(sessionId, path ?? ""),
    enabled: active && dockVisible && path !== null,
    refetchOnWindowFocus: true,
    retry: false
  })
  const diffQuery = useQuery({
    queryKey: ["asset-diff", sessionId],
    queryFn: () => rpc.sessionsDiff(sessionId),
    enabled: active && dockVisible && path !== null,
    refetchOnWindowFocus: true,
    retry: false
  })
  const fileDiff = useMemo(
    () =>
      path !== null && diffQuery.data
        ? parsePierreFileDiffForPath(diffQuery.data, path)
        : null,
    [diffQuery.data, path]
  )
  const asset = path === null ? null : { sessionId, path }
  const canvasError = assetQuery.isError && asset !== null
    ? assetCanvasError(assetQuery.error, asset)
    : null

  return (
    <AssetBrowser
      sessionId={sessionId}
      entries={listQuery.data ?? []}
      selectedPath={path}
      treeLoading={listQuery.isPending}
      treeError={listQuery.isError ? "Couldn't refresh repository files." : null}
      onSelectPath={(path) => {
        void rpc.assetHidePdf()
        onOpenAsset(sessionId, path)
      }}
      renderCanvas={(nativeAvailable) => (
        <AssetCanvas
          selectedPath={path}
          payload={assetQuery.data}
          fileDiff={fileDiff}
          loading={
            path !== null &&
            (assetQuery.isPending || diffQuery.isPending)
          }
          error={canvasError}
          onReveal={asset === null ? undefined : () => void reveal(asset)}
          renderPdf={
            asset === null
              ? undefined
              : (placeholder) => (
                  <PdfBody
                    key={`${asset.sessionId}:${asset.path}`}
                    asset={asset}
                    shown={active && dockVisible && nativeAvailable}
                  >
                    {placeholder}
                  </PdfBody>
                )
          }
        />
      )}
    />
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
  // Open Chromium's viewer over the placeholder the first frame a paintable rect
  // exists (opening on mount stranded the PDF on "Loading PDF…" forever when that
  // first measure was 0×0), and keep it aligned after.
  const boundsRef = useNativeViewBounds({
    active: shown,
    onFirstPaintableRect: (r) => {
      void rpc.assetOpenPdf(asset.sessionId, asset.path, r).catch(() => {})
    },
    onBoundsChanged: (r) => {
      void rpc.browserPreviewSetBounds(r)
    }
  })

  // A native overlay is not hidden by hiding a div, so leaving the tab (or the
  // dock closing) has to say so out loud. The unmount case matters most: closing
  // the tab must not strand a PDF painted over the app.
  useLayoutEffect(() => {
    if (shown) return
    void rpc.assetHidePdf()
  }, [shown])
  useLayoutEffect(
    () => () => {
      void rpc.assetHidePdf()
    },
    []
  )

  return (
    <div ref={boundsRef} className="absolute inset-0">
      {children}
    </div>
  )
}

const reveal = (asset: { sessionId: string; path: string }) =>
  rpc.assetReveal(asset.sessionId, asset.path).catch(() => {})

/** Normalize decoded tagged RPC failures for the presentational canvas. */
function assetCanvasError(
  error: unknown,
  asset: { sessionId: string; path: string }
): AssetCanvasError {
  const failure = Runtime.isFiberFailure(error)
    ? Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId]))
    : error
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) {
    return { type: "error", message: `Couldn't open ${asset.path}.` }
  }
  switch (failure._tag) {
    case "AssetTooLargeError":
      return {
        type: "too-large",
        path: asset.path,
        size: "size" in failure && typeof failure.size === "number" ? failure.size : 0,
        cap: "cap" in failure && typeof failure.cap === "number" ? failure.cap : 0
      }
    case "AssetUnsupportedError":
      return { type: "unsupported", path: asset.path }
    default:
      return { type: "error", message: `Couldn't open ${asset.path}.` }
  }
}
