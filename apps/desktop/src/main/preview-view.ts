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
 * ## Session-owned views with explicit visibility
 *
 * Native overlays do not participate in CSS stacking. Each session therefore
 * owns separate browser and asset views, every new view starts hidden, and only
 * the renderer's focused-owner visibility messages may let one paint. Background
 * BrowserControl work can retain history and scroll state without covering the
 * operator's focused pane.
 *
 * A session's browser and PDF get separate views rather than sharing one. Sharing
 * would mean opening a PDF destroys the browser's `WebContents`, and clicking
 * back to Browser would land on a blank default URL with the page, its history
 * and its scroll position gone — the exact failure the tabbed dock exists to
 * avoid. Idle views are destroyed with their owning session.
 *
 * ## Security posture
 *
 * Both views run with `sandbox: true` + `contextIsolation: true` and NO preload,
 * so neither the previewed page nor the PDF has a bridge to the app.
 *  - the BROWSER view accepts only http/https and permits sandboxed,
 *    opener-connected web popups for sign-in flows; popup descendants and
 *    non-web navigation remain blocked;
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
import { BrowserControlError, BrowserPreviewError } from "@jingler/core"
import { pathToFileURL } from "node:url"
import { BrowserWindow, session as electronSession, WebContentsView } from "electron"
import { Context, Duration, Effect, Layer } from "effect"

/** Which tab a native view belongs to. */
export type PreviewOwner = "browser" | "asset"

/**
 * The browser view's own persistent session, isolated from the app's default
 * session. The view can now be SCRIPTED by an agent (BrowserControl.evaluate et
 * al.), so its cookies must not be the operator's default-session cookies —
 * a partition confines whatever the QA page logs into to this one view. It does
 * not (and cannot) stop scripting the page currently loaded; that is bounded by
 * the same trust boundary as every other privileged RPC. See the PR review note.
 */
export const browserOwnerKey = (sessionId: string, chatId: string): string =>
  `${sessionId}\0${chatId}`

export const browserPartitionForAgent = (sessionId: string, chatId: string): string =>
  `persist:jingler-browser-preview:${encodeURIComponent(sessionId)}:${encodeURIComponent(chatId)}`


/** Hard ceiling on `controlWaitForSelector`, so a bad caller can't pin the RPC. */
const MAX_WAIT_MS = 30_000

/**
 * Main→renderer push: "an agent is driving the browser — open the Preview dock
 * onto it so the operator watches". Sent on every BrowserControl op.
 */
export const PREVIEW_REVEAL_CHANNEL = "jingler/preview/reveal"

/**
 * Main→renderer push for the browser's committed main-frame URL. This is
 * separate from PREVIEW_REVEAL_CHANNEL: redirects and history changes should
 * keep the address bar truthful without stealing focus from another dock tab.
 */
export const PREVIEW_URL_CHANNEL = "jingler/preview/url"

type PendingNavigation = { readonly requestedUrl: string; readonly redirects: ReadonlySet<string> }

export const acceptsPreviewNavigationCommit = (
  pending: PendingNavigation | undefined,
  url: string
): boolean =>
  pending === undefined || pending.requestedUrl === url || pending.redirects.has(url)

export interface PreviewViewServiceShape {
  /** Show the browser view and load `url` at `bounds`. Rejects non-http(s) URLs. */
  readonly openBrowser: (sessionId: string, chatId: string, url: string, bounds: BrowserBounds) => Effect.Effect<void, BrowserPreviewError>
  /** Show Plannotator's loopback-only review app in the Plan tab. */
  /**
   * Show the asset view over `bounds` with `absolutePath` loaded in Chromium's
   * own viewer. The caller MUST have validated containment first.
   */
  readonly openFile: (sessionId: string, absolutePath: string, bounds: BrowserBounds) => Effect.Effect<void, BrowserPreviewError>
  /** Track the internet dock's rect for the named session. */
  readonly setBounds: (sessionId: string, chatId: string, bounds: BrowserBounds) => Effect.Effect<void>
  /** Track a Files PDF placeholder independently from the internet dock. */
  readonly setFileBounds: (sessionId: string, bounds: BrowserBounds) => Effect.Effect<void>
  /** Navigate the browser view. Rejects non-http(s) URLs. */
  readonly navigate: (sessionId: string, chatId: string, url: string) => Effect.Effect<void, BrowserPreviewError>
  /** Reload the browser view. No-op when closed. */
  readonly reload: (sessionId: string, chatId: string) => Effect.Effect<void>
  /**
   * Show or hide the BROWSER view without destroying it — the dock switching to
   * or from the Browser tab. Hiding never discards the page or its history.
   */
  readonly setVisible: (sessionId: string, chatId: string, visible: boolean) => Effect.Effect<void>
  /** Hide the named session's PDF without affecting Preview or split panes. */
  readonly hideFile: (sessionId: string) => Effect.Effect<void>
  /** Destroy one closed chat's browser view without clearing its persistent partition. */
  readonly closeBrowser: (sessionId: string, chatId: string) => Effect.Effect<void>
  /** Permanently destroy one session's views and clear only its browser partition. */
  readonly deleteSession: (
    sessionId: string,
    chatIds: ReadonlyArray<string>
  ) => Effect.Effect<void>
  // ── Agent QA (BrowserControl.*) ──────────────────────────────────────────────
  // The same browser view, driven by an AGENT rather than the operator. Every op
  // ensures the owning session's view exists and notifies the renderer. A
  // focused owner reveals its dock; a background owner remains hidden. Errors
  // carry the failing `op`.
  /** Load `url` (http/https only) into the browser and reveal the dock. */
  readonly controlNavigate: (sessionId: string, chatId: string, url: string) => Effect.Effect<void, BrowserControlError>
  /** PNG screenshot of the current page, base64-encoded. */
  readonly controlScreenshot: (sessionId: string, chatId: string) => Effect.Effect<{ pngBase64: string }, BrowserControlError>
  /** Click the first element matching `selector`; fails if nothing matches. */
  readonly controlClick: (sessionId: string, chatId: string, selector: string) => Effect.Effect<void, BrowserControlError>
  /** Type `text` into the first element matching `selector`; fails if none. */
  readonly controlType: (sessionId: string, chatId: string, selector: string, text: string) => Effect.Effect<void, BrowserControlError>
  /** The page's visible text (`document.body.innerText`). */
  readonly controlReadText: (sessionId: string, chatId: string) => Effect.Effect<{ text: string }, BrowserControlError>
  /** Evaluate `expression` in the page; returns a string (JSON for non-strings). */
  readonly controlEvaluate: (sessionId: string, chatId: string, expression: string) => Effect.Effect<{ result: string }, BrowserControlError>
  /** Resolve once `selector` appears in the DOM, or fail after `timeoutMs`. */
  readonly controlWaitForSelector: (
    sessionId: string,
    chatId: string,
    selector: string,
    timeoutMs: number
  ) => Effect.Effect<void, BrowserControlError>
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

/** OAuth commonly opens about:blank first, then assigns its real web URL. */
export const isBrowserPopupUrl = (url: string): boolean =>
  url === "about:blank" || isHttpUrl(url)

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

export const PreviewViewServiceLive = Layer.scoped(PreviewViewService, Effect.gen(function* () {
  // Browser WebContents are session resources: each retains its own history,
  // scroll position and persistent storage partition while only one may paint.
  const browserViews = new Map<string, WebContentsView>()
  const assetViews = new Map<string, WebContentsView>()
  const visibleBrowserSessions = new Set<string>()
  const visibleAssetSessions = new Set<string>()
  // Session deletion is terminal. A late BrowserControl RPC from an agent being
  // torn down must not recreate the deleted session's native overlay.
  const deletedSessionIds = new Set<string>()
  // `controlNavigate` reveals the dock before its awaited load commits. The
  // renderer answers that reveal by calling `openBrowser`; without this guard a
  // still-blank WebContents starts a second load and Electron aborts the first.
  const controlledNavigations = new Set<string>()
  const pendingNavigations = new Map<string, { requestedUrl: string; redirects: Set<string> }>()
  let visibilityWindow: BrowserWindow | null = null
  let windowFocused = process.env.JINGLER_E2E_HEADLESS === "1"

  const mainWindow = (): BrowserWindow | null => BrowserWindow.getAllWindows()[0] ?? null

  const syncBrowserVisibility = (visible: boolean): void => {
    for (const [key, view] of browserViews) {
      view.setVisible(visible && visibleBrowserSessions.has(key))
    }
  }

  // A visible browser WebContentsView may activate its host when a background load finishes.
  // Keep browser previews hidden while Jingler is inactive; agent control still works.
  const hideBrowserViews = (): void => {
    windowFocused = false
    syncBrowserVisibility(false)
  }
  const restoreBrowserViews = (): void => {
    windowFocused = true
    syncBrowserVisibility(true)
  }
  const unbindWindowVisibility = (): void => {
    visibilityWindow?.off("blur", hideBrowserViews)
    visibilityWindow?.off("focus", restoreBrowserViews)
    visibilityWindow?.off("closed", unbindWindowVisibility)
    visibilityWindow = null
  }

  const bindWindowVisibility = (win: BrowserWindow): void => {
    if (visibilityWindow === win) return
    unbindWindowVisibility()
    visibilityWindow = win
    windowFocused = process.env.JINGLER_E2E_HEADLESS === "1" || win.isFocused()
    win.on("blur", hideBrowserViews)
    win.on("focus", restoreBrowserViews)
    win.on("closed", unbindWindowVisibility)
  }

  const setOwnerVisible = (
    views: Map<string, WebContentsView>,
    visibleSessions: Set<string>,
    sessionId: string,
    wanted: boolean
  ) => {
    if (wanted) visibleSessions.add(sessionId)
    else visibleSessions.delete(sessionId)
    views.get(sessionId)?.setVisible(wanted && (views !== browserViews || windowFocused))
  }

  /** Load a URL, swallowing failures (dev server down, PDF deleted) so the RPC
   *  still succeeds and the view shows Chromium's own error page. */
  const load = (view: WebContentsView | null, url: string) => {
    view?.webContents.loadURL(url).catch(() => {})
  }

  const createView = (owner: PreviewOwner, sessionId: string | null, chatId: string | null = null): WebContentsView | null => {
    const win = mainWindow()
    if (!win) return null
    bindWindowVisibility(win)
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Only the browsable view is isolated; the asset view is a file:// PDF
        // in Chromium's viewer with no login state to leak.
        ...(owner === "browser" && sessionId !== null
          ? { partition: browserPartitionForAgent(sessionId, chatId ?? "") }
          : {})
      }
    })
    // WebContentsView starts visible. A BrowserControl operation may create and
    // size a background session's view before the renderer can decide whether
    // that owner is focused, so attach every native overlay hidden and let the
    // explicit owner-visibility path be the only way it can paint.
    view.setVisible(false)
    if (owner === "browser" && sessionId !== null) {
      const partition = browserPartitionForAgent(sessionId, chatId ?? "")
      view.webContents.setWindowOpenHandler(({ url }) =>
        isBrowserPopupUrl(url)
          ? {
              action: "allow",
              overrideBrowserWindowOptions: {
                parent: win,
                width: 520,
                height: 720,
                minWidth: 360,
                minHeight: 480,
                autoHideMenuBar: true,
                webPreferences: {
                  partition,
                  sandbox: true,
                  contextIsolation: true,
                  nodeIntegration: false,
                  webSecurity: true,
                  allowRunningInsecureContent: false
                }
              }
            }
          : { action: "deny" }
      )
      view.webContents.on("did-create-window", (popup) => {
        // The opener needs a real child window for OAuth postMessage/close.
        // The child never needs to create grandchildren or leave web schemes.
        popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
        const blockUnsafeScheme = (event: { preventDefault: () => void }, url: string) => {
          if (!isBrowserPopupUrl(url)) event.preventDefault()
        }
        popup.webContents.on("will-navigate", blockUnsafeScheme)
        popup.webContents.on("will-redirect", blockUnsafeScheme)
      })
    } else {
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    }
    view.webContents.on("will-navigate", (event, url) => {
      // The asset view holds a `file://` document. A PDF's links must not be
      // followable — a file-origin page that can navigate can walk the disk.
      if (owner === "asset" || !isHttpUrl(url)) {
        event.preventDefault()
        return
      }
    })
    if (owner === "browser" && sessionId !== null && chatId !== null) {
      const key = browserOwnerKey(sessionId, chatId)
      const publishUrl = (url: string) => {
        if (!isHttpUrl(url)) return
        const pending = pendingNavigations.get(key)
        if (!acceptsPreviewNavigationCommit(pending, url)) return
        pendingNavigations.delete(key)
        mainWindow()?.webContents.send(PREVIEW_URL_CHANNEL, { sessionId, chatId, url })
      }
      view.webContents.on("will-redirect", (details) => {
        if (details.isMainFrame) pendingNavigations.get(key)?.redirects.add(details.url)
      })
      view.webContents.on("did-fail-load", (_event, _code, _description, url, isMainFrame) => {
        if (!isMainFrame) return
        const pending = pendingNavigations.get(key)
        if (
          pending !== undefined &&
          (url === pending.requestedUrl || pending.redirects.has(url))
        ) pendingNavigations.delete(key)
      })
      view.webContents.on("did-navigate", (_event, url) => publishUrl(url))
      view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
        if (isMainFrame) publishUrl(url)
      })
    }
    win.contentView.addChildView(view)
    return view
  }

  const ensureBrowser = (sessionId: string, chatId: string): WebContentsView | null => {
    if (deletedSessionIds.has(sessionId)) return null
    const key = browserOwnerKey(sessionId, chatId)
    const existing = browserViews.get(key)
    if (existing !== undefined) return existing
    const view = createView("browser", sessionId, chatId)
    if (view !== null) browserViews.set(key, view)
    return view
  }

  const ensureAsset = (sessionId: string): WebContentsView | null => {
    if (deletedSessionIds.has(sessionId)) return null
    const existing = assetViews.get(sessionId)
    if (existing !== undefined) return existing
    const view = createView("asset", sessionId)
    if (view !== null) assetViews.set(sessionId, view)
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

  const controlFail = (op: string) => (cause: unknown) =>
    new BrowserControlError({
      op,
      message: cause instanceof Error ? cause.message : String(cause)
    })

  // A view an agent created (dock never opened) has no bounds, so `capturePage`
  // would hand back an empty image. Give a fresh one a real size; the renderer's
  // reveal loop then takes over positioning it against the real dock rect.
  const ensureBrowserSized = (sessionId: string, chatId: string): WebContentsView | null => {
    const v = ensureBrowser(sessionId, chatId)
    if (v && v.getBounds().width === 0) {
      v.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    }
    return v
  }

  // Reveal is a renderer request, not permission to paint. The focused owning
  // session will answer with setVisible(true); a background session records the
  // request without stealing the native overlay.
  const reveal = (sessionId: string, chatId: string, url: string) => {
    mainWindow()?.webContents.send(PREVIEW_REVEAL_CHANNEL, { sessionId, chatId, url })
  }

  const withPage = <A>(
    sessionId: string,
    chatId: string,
    op: string,
    f: (wc: WebContentsView["webContents"]) => Promise<A>
  ): Effect.Effect<A, BrowserControlError> =>
    Effect.suspend(() => {
      const v = ensureBrowserSized(sessionId, chatId)
      if (!v) {
        return Effect.fail(
          new BrowserControlError({ op, message: "No application window to attach the browser to" })
        )
      }
      reveal(sessionId, chatId, v.webContents.getURL())
      return Effect.tryPromise({ try: () => f(v.webContents), catch: controlFail(op) })
    })

  const closeAllNow = (): void => {
    for (const view of browserViews.values()) destroy(view)
    browserViews.clear()
    for (const view of assetViews.values()) destroy(view)
    assetViews.clear()
    visibleBrowserSessions.clear()
    visibleAssetSessions.clear()
    pendingNavigations.clear()
  }

  const closeSessionNow = (sessionId: string): void => {
    for (const [key, view] of browserViews) {
      if (!key.startsWith(`${sessionId}\0`)) continue
      destroy(view)
      browserViews.delete(key)
      visibleBrowserSessions.delete(key)
      pendingNavigations.delete(key)
    }
    destroy(assetViews.get(sessionId) ?? null)
    assetViews.delete(sessionId)
    visibleAssetSessions.delete(sessionId)
  }

  yield* Effect.addFinalizer(() => Effect.sync(() => {
    unbindWindowVisibility()
    closeAllNow()
  }))

  return {
    openBrowser: (sessionId, chatId, url, bounds) =>
      isHttpUrl(url)
        ? Effect.sync(() => {
            const key = browserOwnerKey(sessionId, chatId)
            const v = ensureBrowser(sessionId, chatId)
            if (!v) return
            v.setBounds(toRect(bounds))
            // Adopt a page an agent already navigated to (controlNavigate) rather
            // than reloading over it. The renderer opens with its own DEFAULT_URL
            // on first paint, unaware the QA target is already in the view — and
            // clobbering it here would point every subsequent screenshot/click at
            // the wrong page. A fresh view (getURL empty / about:blank) still loads.
            const current = v.webContents.getURL()
            if (
              !controlledNavigations.has(key) &&
              (current === "" || current === "about:blank")
            ) {
              load(v, url)
            }
            setOwnerVisible(browserViews, visibleBrowserSessions, key, true)
          })
        : rejectBadUrl(url),

    openFile: (sessionId, absolutePath, bounds) =>
      Effect.sync(() => {
        const v = ensureAsset(sessionId)
        if (!v) return
        v.setBounds(toRect(bounds))
        load(v, fileUrlFor(absolutePath))
        setOwnerVisible(assetViews, visibleAssetSessions, sessionId, true)
      }),

    setBounds: (sessionId, chatId, bounds) => Effect.sync(() => {
      const key = browserOwnerKey(sessionId, chatId)
      if (visibleBrowserSessions.has(key)) {
        browserViews.get(key)?.setBounds(toRect(bounds))
      }
    }),

    setFileBounds: (sessionId, bounds) => Effect.sync(() => {
      if (visibleAssetSessions.has(sessionId)) {
        assetViews.get(sessionId)?.setBounds(toRect(bounds))
      }
    }),

    navigate: (sessionId, chatId, url) =>
      isHttpUrl(url)
        ? Effect.sync(() => {
            const key = browserOwnerKey(sessionId, chatId)
            const view = browserViews.get(key) ?? null
            if (view === null) return
            pendingNavigations.set(key, { requestedUrl: url, redirects: new Set() })
            load(view, url)
          })
        : rejectBadUrl(url),

    reload: (sessionId, chatId) =>
      Effect.sync(() => browserViews.get(browserOwnerKey(sessionId, chatId))?.webContents.reload()),

    setVisible: (sessionId, chatId, wanted) =>
      Effect.sync(() => {
        setOwnerVisible(browserViews, visibleBrowserSessions, browserOwnerKey(sessionId, chatId), wanted)
      }),

    hideFile: (sessionId) => Effect.sync(() => {
      setOwnerVisible(assetViews, visibleAssetSessions, sessionId, false)
    }),

    closeBrowser: (sessionId, chatId) => Effect.sync(() => {
      const key = browserOwnerKey(sessionId, chatId)
      destroy(browserViews.get(key) ?? null)
      browserViews.delete(key)
      visibleBrowserSessions.delete(key)
      controlledNavigations.delete(key)
      pendingNavigations.delete(key)
    }),

    deleteSession: (sessionId, knownChatIds) =>
      Effect.gen(function* () {
        deletedSessionIds.add(sessionId)
        const chatIds = new Set([
          ...knownChatIds,
          ...[...browserViews.keys()]
            .filter((key) => key.startsWith(`${sessionId}\0`))
            .map((key) => key.slice(sessionId.length + 1))
        ])
        closeSessionNow(sessionId)
        yield* Effect.forEach(chatIds, (chatId) =>
          Effect.tryPromise(() =>
            electronSession.fromPartition(browserPartitionForAgent(sessionId, chatId)).clearStorageData()
          ).pipe(Effect.catchAll(() => Effect.void))
        )
      }),

    controlNavigate: (sessionId, chatId, url) =>
      isHttpUrl(url)
        ? Effect.suspend(() => {
            const key = browserOwnerKey(sessionId, chatId)
            const v = ensureBrowserSized(sessionId, chatId)
            if (!v) {
              return Effect.fail(new BrowserControlError({
                op: "navigate",
                message: "No application window to attach the browser to"
              }))
            }
            controlledNavigations.add(key)
            reveal(sessionId, chatId, url)
            return Effect.tryPromise({
              try: () => v.webContents.loadURL(url),
              catch: controlFail("navigate")
            }).pipe(
              Effect.tap(() => Effect.sync(() => reveal(sessionId, chatId, v.webContents.getURL()))),
              Effect.ensuring(Effect.sync(() => controlledNavigations.delete(key)))
            )
          })
        : Effect.fail(
            new BrowserControlError({ op: "navigate", message: `Only http(s) URLs can be opened: ${url}` })
          ),

    controlScreenshot: (sessionId, chatId) =>
      withPage(sessionId, chatId, "screenshot", async (wc) => {
        const image = await wc.capturePage()
        return { pngBase64: image.toPNG().toString("base64") }
      }),

    controlClick: (sessionId, chatId, selector) =>
      withPage(sessionId, chatId, "click", async (wc) => {
        const hit = await wc.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
            ` if (!el) return false; el.click(); return true; })()`
        )
        if (!hit) throw new Error(`No element matches selector: ${selector}`)
      }),

    controlType: (sessionId, chatId, selector, text) =>
      withPage(sessionId, chatId, "type", async (wc) => {
        // Set the value through the ELEMENT-PROTOTYPE setter, not `el.value = …`.
        // React installs its own `value` setter to track the last value it wrote;
        // assigning directly leaves that tracker equal to the new DOM value, so
        // React's onChange treats the synthetic `input` as a no-op and controlled
        // components snap back. The native setter bypasses the tracker, which is
        // how testing-library/user-event drive React inputs too.
        const hit = await wc.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
            ` if (!el) return false; el.focus();` +
            ` const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype` +
            ` : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;` +
            ` const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;` +
            ` if (setter) setter.call(el, ${JSON.stringify(text)});` +
            ` else if ('value' in el) { el.value = ${JSON.stringify(text)}; }` +
            ` el.dispatchEvent(new Event('input', { bubbles: true }));` +
            ` el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
        )
        if (!hit) throw new Error(`No element matches selector: ${selector}`)
      }),

    controlReadText: (sessionId, chatId) =>
      withPage(sessionId, chatId, "readText", async (wc) => {
        const text = await wc.executeJavaScript(`document.body ? document.body.innerText : ""`)
        return { text: typeof text === "string" ? text : String(text ?? "") }
      }),

    controlEvaluate: (sessionId, chatId, expression) =>
      withPage(sessionId, chatId, "evaluate", async (wc) => {
        const result = await wc.executeJavaScript(
          `(() => { const __r = (${expression});` +
            ` return typeof __r === "string" ? __r : JSON.stringify(__r); })()`
        )
        return { result: typeof result === "string" ? result : String(result ?? "") }
      }),

    controlWaitForSelector: (sessionId, chatId, selector, timeoutMs) => {
      // Clamp first: a caller passing 1e12 must not be able to pin the RPC.
      const budget = Math.min(Math.max(Math.trunc(Number(timeoutMs)) || 0, 0), MAX_WAIT_MS)
      return withPage(sessionId, chatId, "waitForSelector", async (wc) => {
        const found = await wc.executeJavaScript(
          `new Promise((resolve) => {` +
            ` const sel = ${JSON.stringify(selector)};` +
            ` if (document.querySelector(sel)) return resolve(true);` +
            ` const start = Date.now();` +
            ` const iv = setInterval(() => {` +
            ` if (document.querySelector(sel)) { clearInterval(iv); resolve(true); }` +
            ` else if (Date.now() - start > ${budget}) { clearInterval(iv); resolve(false); }` +
            ` }, 100); })`
        )
        if (!found) throw new Error(`Timed out waiting for selector: ${selector}`)
      }).pipe(
        // Backstop the in-page timer in the MAIN process: a navigation, reload or
        // HMR refresh destroys the script context while the poll is pending, so
        // the injected Promise never settles and `executeJavaScript` would hang
        // forever. This bounds the whole op regardless.
        Effect.timeoutFail({
          duration: Duration.millis(budget + 2_000),
          onTimeout: () =>
            new BrowserControlError({
              op: "waitForSelector",
              message: `Timed out waiting for selector: ${selector}`
            })
        })
      )
    }
  }
}))
