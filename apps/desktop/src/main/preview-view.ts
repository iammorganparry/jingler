/**
 * PreviewViewService — the main-process owner of every NATIVE view the Preview
 * dock puts on screen: the embedded browser, and PDFs.
 *
 * Both are `WebContentsView`s (Electron's recommended embed) layered over the
 * renderer at the dock's on-screen rect. They live in the main process because
 * `WebContentsView` is main-only, and they render OUTSIDE the renderer's DOM and
 * CSP — which is exactly why they can load an arbitrary `http://localhost` dev
 * server, or Chromium's built-in PDF viewer, that `default-src 'self'` would
 * otherwise block. Rendering PDFs this way is why the app ships no pdf.js.
 *
 * ## One view per owner, at most one VISIBLE
 *
 * A native overlay does not participate in CSS stacking, so a view left showing
 * while the dock displays another tab simply paints over it. Every path through
 * this service therefore ends in `showOnly`, which is the single place that
 * decides what is on screen.
 *
 * The browser and a PDF get SEPARATE views rather than sharing one. Sharing
 * would mean opening a PDF destroys the browser's `WebContents`, and clicking
 * back to Browser would land on a blank default URL with the page, its history
 * and its scroll position gone — the exact failure the tabbed dock exists to
 * avoid. Two idle views is a far smaller cost than that.
 *
 * ## Security posture
 *
 * Both views run with `sandbox: true` + `contextIsolation: true` and NO preload,
 * so neither the previewed page nor the PDF has a bridge to the app.
 *  - the BROWSER view accepts only http/https, denies `window.open`, and blocks
 *    in-page navigation to non-http(s) schemes;
 *  - the ASSET view accepts only `file://`, and blocks EVERY in-page navigation.
 *    A PDF can carry links, and a `file://` document that is allowed to follow
 *    them can walk the disk. Nothing legitimate needs it: the file is delivered
 *    by `loadURL`, which does not go through `will-navigate`.
 *
 * Crucially, the renderer never names the file. `openFile` is only reached via
 * the `Asset.openPdf` handler, which resolves the path through `AssetService` —
 * so the same worktree-containment check that guards a read also guards this.
 *
 * There is exactly one window (see rpc.ts), so views attach to
 * `BrowserWindow.getAllWindows()[0]`.
 */
import type { BrowserBounds } from "@jingler/core"
import { BrowserPreviewError } from "@jingler/core"
import { pathToFileURL } from "node:url"
import { BrowserWindow, WebContentsView } from "electron"
import { Context, Effect, Layer } from "effect"

/** Which tab a native view belongs to. */
export type PreviewOwner = "browser" | "asset"

export interface PreviewViewServiceShape {
  /** Show the browser view and load `url` at `bounds`. Rejects non-http(s) URLs. */
  readonly openBrowser: (url: string, bounds: BrowserBounds) => Effect.Effect<void, BrowserPreviewError>
  /**
   * Show the asset view over `bounds` with `absolutePath` loaded in Chromium's
   * own viewer. The caller MUST have validated containment first.
   */
  readonly openFile: (absolutePath: string, bounds: BrowserBounds) => Effect.Effect<void, BrowserPreviewError>
  /** Track the dock's rect (layout/scroll) for whichever view is visible. */
  readonly setBounds: (bounds: BrowserBounds) => Effect.Effect<void>
  /** Navigate the browser view. Rejects non-http(s) URLs. */
  readonly navigate: (url: string) => Effect.Effect<void, BrowserPreviewError>
  /** Reload the browser view. No-op when closed. */
  readonly reload: () => Effect.Effect<void>
  /**
   * Show or hide the BROWSER view without destroying it — the dock switching to
   * or from the Browser tab. Hiding never discards the page or its history.
   */
  readonly setVisible: (visible: boolean) => Effect.Effect<void>
  /** Hide the asset view (the dock switched away from a PDF tab). */
  readonly hideFile: () => Effect.Effect<void>
  /** Destroy every view. Idempotent. */
  readonly close: () => Effect.Effect<void>
  /** Test/diagnostic seam: which owner is currently painted, if any. */
  readonly visibleOwner: () => Effect.Effect<PreviewOwner | null>
}

export class PreviewViewService extends Context.Tag("@jingler/PreviewViewService")<
  PreviewViewService,
  PreviewViewServiceShape
>() {}

/** Only http/https load into the browser view — it's a dev-server viewer. Exported for tests. */
export const isHttpUrl = (url: string): boolean => {
  try {
    const p = new URL(url).protocol
    return p === "http:" || p === "https:"
  } catch {
    return false
  }
}

/**
 * An absolute path as a `file:` URL.
 *
 * `pathToFileURL` rather than string concatenation because a real worktree path
 * contains characters that are structural in a URL: a `#` in a filename would
 * truncate the path at a fragment and load the wrong file (or nothing), and a
 * space would not survive at all. Exported for tests.
 */
export const fileUrlFor = (absolutePath: string): string => pathToFileURL(absolutePath).href

/** Integer device-independent pixels — `setBounds` requires ints. Exported for tests. */
export const toRect = (b: BrowserBounds) => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.max(0, Math.round(b.width)),
  height: Math.max(0, Math.round(b.height))
})

export const PreviewViewServiceLive = Layer.sync(PreviewViewService, () => {
  // One view per owner (either may be null), captured in this closure so the
  // service value is stateful without a class.
  let browserView: WebContentsView | null = null
  let assetView: WebContentsView | null = null
  let visible: PreviewOwner | null = null

  const mainWindow = (): BrowserWindow | null => BrowserWindow.getAllWindows()[0] ?? null

  const viewFor = (owner: PreviewOwner): WebContentsView | null =>
    owner === "browser" ? browserView : assetView

  /**
   * The ONLY place that decides what is painted. Passing null hides everything.
   *
   * Every caller routes through here rather than flipping its own view's
   * visibility, because the bug this prevents is not "my view is hidden" — it is
   * "the OTHER view is still showing", which no single owner is positioned to
   * notice.
   */
  const showOnly = (owner: PreviewOwner | null) => {
    browserView?.setVisible(owner === "browser")
    assetView?.setVisible(owner === "asset")
    visible = owner
  }

  /** Load a URL, swallowing failures (dev server down, PDF deleted) so the RPC
   *  still succeeds and the view shows Chromium's own error page. */
  const load = (view: WebContentsView | null, url: string) => {
    view?.webContents.loadURL(url).catch(() => {})
  }

  const ensure = (owner: PreviewOwner): WebContentsView | null => {
    const win = mainWindow()
    if (!win) return null
    const existing = viewFor(owner)
    if (existing) return existing
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    view.webContents.on("will-navigate", (event, url) => {
      // The asset view holds a `file://` document. A PDF's links must not be
      // followable — a file-origin page that can navigate can walk the disk.
      if (owner === "asset" || !isHttpUrl(url)) event.preventDefault()
    })
    win.contentView.addChildView(view)
    if (owner === "browser") browserView = view
    else assetView = view
    return view
  }

  const destroy = (view: WebContentsView | null) => {
    if (!view) return
    mainWindow()?.contentView.removeChildView(view)
    // `close()` tears down the WebContents; guard in case it's already gone.
    try {
      view.webContents.close()
    } catch {
      /* already destroyed */
    }
  }

  const rejectBadUrl = (url: string) =>
    Effect.fail(new BrowserPreviewError({ message: `Only http(s) URLs can be previewed: ${url}` }))

  return {
    openBrowser: (url, bounds) =>
      isHttpUrl(url)
        ? Effect.sync(() => {
            const v = ensure("browser")
            if (!v) return
            v.setBounds(toRect(bounds))
            load(v, url)
            showOnly("browser")
          })
        : rejectBadUrl(url),

    openFile: (absolutePath, bounds) =>
      Effect.sync(() => {
        const v = ensure("asset")
        if (!v) return
        v.setBounds(toRect(bounds))
        load(v, fileUrlFor(absolutePath))
        showOnly("asset")
      }),

    // Bounds go to the VISIBLE view only. Pushing them to a hidden one is
    // harmless but pointless, and would resize a PDF every frame the browser is
    // being dragged.
    setBounds: (bounds) => Effect.sync(() => {
      const v = visible ? viewFor(visible) : null
      v?.setBounds(toRect(bounds))
    }),

    navigate: (url) =>
      isHttpUrl(url) ? Effect.sync(() => load(browserView, url)) : rejectBadUrl(url),

    reload: () => Effect.sync(() => browserView?.webContents.reload()),

    setVisible: (wanted) =>
      Effect.sync(() => {
        if (wanted) showOnly("browser")
        else if (visible === "browser") showOnly(null)
      }),

    hideFile: () => Effect.sync(() => {
      if (visible === "asset") showOnly(null)
    }),

    close: () =>
      Effect.sync(() => {
        destroy(browserView)
        destroy(assetView)
        browserView = null
        assetView = null
        visible = null
      }),

    visibleOwner: () => Effect.sync(() => visible)
  }
})
