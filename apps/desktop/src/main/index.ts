/**
 * Electron main entry — standard electron-vite lifecycle. On ready it forces the
 * Effect runtime to build (which forks the RPC server and registers the IPC
 * listener) and then opens the window. The renderer talks to the backend purely
 * through the RPC transport in `./rpc.ts`.
 *
 * It also owns the `jingler://` deep-link sign-in bridge: a single-instance lock
 * keeps auth callbacks landing in the running app, and an inbound callback stores
 * the session token (OS keychain, via `SecretStore`) before telling the renderer
 * to re-check auth.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  DiscoveryService,
  killAllChildren,
  killAllPtysSync,
  ModelsService,
  PluginHost,
  SecretStore
} from "@jingler/cli-adapters"
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { Effect } from "effect"
import type { AuthCallback } from "./deep-link.js"
import {
  AUTH_COMPLETE_CHANNEL,
  findDeepLinkInArgv,
  parseAuthCallback,
  registerProtocolClient
} from "./deep-link.js"
import { jinglerRoot } from "./app-paths.js"
import { isExternallyOpenable, sameOrigin } from "./window-guards.js"
import { registerPluginProtocolHandler, registerPluginScheme } from "./plugin-protocol.js"
import { makeHostRequestHandler, spawnHostProcess } from "./plugin-host-bridge.js"
import { installPluginHost } from "./plugin-host-install.js"
import { nativeConsentPrompt } from "./plugin-consent.js"
import { bootBackgroundColor, registerBootThemeChannel, resolveBootTheme } from "./boot-theme.js"
import { runtime } from "./runtime.js"
import { initAutoUpdater } from "./updater.js"

/** The single renderer window (kept so deep-link callbacks can reach + focus it). */
let mainWindow: BrowserWindow | null = null

/**
 * Development builds keep a redacted Codex lifecycle trace so an intermittent
 * silent turn leaves evidence after its ten-minute watchdog fires. Packaged
 * builds and headless e2e remain unchanged; developers can explicitly disable
 * it with `JINGLER_CODEX_DIAGNOSTICS=0`.
 */
const enableCodexDiagnostics = (): void => {
  if (
    app.isPackaged ||
    process.env.JINGLER_E2E_HEADLESS === "1" ||
    process.env.JINGLER_CODEX_DIAGNOSTICS === "0"
  ) {
    return
  }
  process.env.JINGLER_CODEX_DIAGNOSTICS_DIR ??= join(
    jinglerRoot,
    "diagnostics",
    "codex"
  )
  console.info(
    `[codex-diagnostics] redacted traces: ${process.env.JINGLER_CODEX_DIAGNOSTICS_DIR}`
  )
}

/**
 * Warm `ModelsService`'s cache before anything asks for it.
 *
 * Discovering models is the slowest read the app makes: it probes for each CLI
 * and then asks the Codex CLI for its catalogue over its app-server protocol.
 * Doing that lazily means the first session's model chip fills in a beat late.
 * Doing it here means it happens while the window paints and the user signs in —
 * by the time anyone opens a session, `Models.catalog` is a cache hit.
 *
 * Deliberately fire-and-forget: it must never delay the window or fail the boot.
 * A cold cache is only ever a slower chip, never a broken app, so nothing waits
 * on this and every error is swallowed.
 */
const prefetchModels = Effect.gen(function* () {
  const clis = yield* DiscoveryService.list()
  yield* ModelsService.catalog(clis)
}).pipe(Effect.ignore)

// Only one instance may run: a second launch (e.g. the OS handing us a
// `jingler://` deep link) must forward its argv into the primary instance
// rather than spawn a rival window. If we didn't get the lock, we're that second
// launch — quit immediately and let `second-instance` do the delivery.
const gotPrimaryLock = app.requestSingleInstanceLock()
if (!gotPrimaryLock) {
  app.quit()
} else {
  registerProtocolClient()

  /** Open an http(s) URL (e.g. a PR link) in the user's default browser. */
  ipcMain.handle("jingler/open-external", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  /**
   * Deliver a parsed auth callback: persist the token (keychain) then notify the
   * renderer. A token-less callback (or a storage failure) reports `ok: false` so
   * the LoginScreen can show its error state.
   */
  const deliverAuthCallback = (cb: AuthCallback): void => {
    const notify = (ok: boolean, error: string | null = null) =>
      mainWindow?.webContents.send(AUTH_COMPLETE_CHANNEL, { ok, error })
    if (!cb.token) {
      notify(false, cb.error)
      return
    }
    const token = cb.token
    void runtime
      .runPromise(Effect.flatMap(SecretStore, (store) => store.set(token)))
      .then(() => notify(true))
      .catch(() => notify(false, "storage"))
  }

  const focusMainWindow = (): void => {
    if (!mainWindow) return
    // Deep-link handling focuses the window; under headless e2e that would undo
    // the whole point (the auth specs drive deep links repeatedly).
    if (process.env.JINGLER_E2E_HEADLESS === "1") return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  // macOS delivers the deep link as an event, even while running.
  app.on("open-url", (event, url) => {
    event.preventDefault()
    const cb = parseAuthCallback(url)
    if (cb) deliverAuthCallback(cb)
  })

  // Windows/Linux deliver it as argv on the second launch.
  app.on("second-instance", (_event, argv) => {
    const link = findDeepLinkInArgv(argv)
    if (link) {
      const cb = parseAuthCallback(link)
      if (cb) deliverAuthCallback(cb)
    }
    focusMainWindow()
  })

  /**
   * The window's pre-paint background, resolved from the active theme.
   *
   * Seeded with the Jingler Dark canvas so a window created before the theme
   * has resolved still looks like the app rather than like a white rectangle.
   * In practice `whenReady` resolves the theme before the first `createWindow`;
   * this only covers the `activate` path on macOS if that somehow races.
   *
   * Must stay equal to `--sb-canvas` in globals.css — they are the same frame
   * of the same launch, painted by two different processes.
   */
  let themeBackgroundColor = "#141414"

  /**
   * The window icon, on the one platform that reads it.
   *
   * macOS takes the icon from the .app bundle and Windows from the .exe, both
   * of which electron-builder stamps at package time — passing `icon` there is
   * ignored at best. Linux is the exception: the running window's taskbar entry
   * comes from `BrowserWindow.icon`, and without it the app sits in the dock as
   * a generic Electron diamond even though the AppImage itself is branded.
   *
   * Returns `undefined` rather than a guessed path when the file is missing, so
   * a dev checkout that has not built icons still opens a window.
   */
  const windowIcon = (): string | undefined => {
    if (process.platform !== "linux") return undefined
    const candidate = app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build-resources/icon.png")
    return existsSync(candidate) ? candidate : undefined
  }

  const createWindow = () => {
    const window = new BrowserWindow({
      width: 1320,
      height: 860,
      icon: windowIcon(),
      // The shell collapses gracefully (see `width-tier.tsx`) but it collapses
      // to a floor, not to nothing: below this the sidebar rail, a pane's tab
      // bar and the composer's wrapped toolbar have no room left to give, and
      // the fixed-width dialogs would clip. Half of a 1920px display is 960 —
      // deliberately just above this, so the commonest split-screen gesture
      // lands inside the supported range rather than at the limit.
      minWidth: 900,
      minHeight: 600,
      show: false,
      // Electron paints this before any HTML exists. Hardcoding the One Dark
      // canvas here meant a light theme flashed dark on every single launch,
      // before the document had a chance to say otherwise.
      backgroundColor: themeBackgroundColor,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/index.mjs"),
        contextIsolation: true,
        sandbox: false
      }
    })
    mainWindow = window

    /**
     * The renderer window is a one-way door: nothing gets to navigate it, and
     * nothing gets to open a second window from it.
     *
     * Both matter because of what this window's `webPreferences` carry. The
     * preload exposes `window.jingler.send/on` — the whole RPC bridge, and with
     * it Terminal, Workspace and Auth. Electron hands a `window.open`ed child
     * the OPENER'S web preferences, so a new window would inherit that preload,
     * and whatever remote page loaded in it would have a live channel to it.
     *
     * The content this guards is not hypothetical or user-authored: agent
     * markdown is rendered as real links, and a prompt-injected agent emitting
     * `[docs](https://attacker.com)` is a realistic way to get one click.
     *
     * So: deny every window-open request outright, and hand http(s) to the
     * user's real browser instead — which is what every deliberate external link
     * in the app already does via `jingler/open-external`. Non-http(s) schemes
     * are dropped rather than passed to `shell.openExternal`, which would happily
     * launch an arbitrary protocol handler.
     */
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternallyOpenable(url)) void shell.openExternal(url)
      return { action: "deny" }
    })

    /**
     * In-place navigation away from the app is likewise never legitimate — the
     * renderer only ever loads its own bundle. Letting a link replace the
     * document would put a remote origin on the same `webContents`, preload and
     * all, which is the same hole without needing a second window.
     */
    window.webContents.on("will-navigate", (event, url) => {
      // Same-origin is allowed, not same-URL: Vite's dev server reloads the page
      // on an HMR failure, and blocking that would make the dev loop look broken
      // in a way nothing reports. `file://` URLs have an opaque "null" origin, so
      // the packaged build compares hrefs instead.
      if (sameOrigin(url, window.webContents.getURL())) return
      event.preventDefault()
      if (isExternallyOpenable(url)) void shell.openExternal(url)
    })

    // Headless e2e: never show the window and never take the dock/focus.
    //
    // The Playwright suite launches a real Electron app dozens of times, and each
    // `show()` steals focus from whatever the developer is doing — which makes
    // running the suite locally (the ONLY place it runs; it's not in CI)
    // incompatible with using the machine. The renderer still loads and is fully
    // drivable while hidden, and `toBeVisible()` asserts DOM visibility, not
    // window visibility, so specs behave identically.
    if (process.env.JINGLER_E2E_HEADLESS === "1") {
      app.dock?.hide()
    } else {
      window.on("ready-to-show", () => window.show())
    }
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null
    })

    // Cold-start deep link (Windows/Linux): the URL is in our own argv. Deliver it
    // once the renderer has loaded so the auth-complete event isn't dropped.
    const coldLink = findDeepLinkInArgv(process.argv)
    if (coldLink) {
      window.webContents.once("did-finish-load", () => {
        const cb = parseAuthCallback(coldLink)
        if (cb) deliverAuthCallback(cb)
      })
    }

    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(import.meta.dirname, "../renderer/index.html"))
    }
  }

  // Before `whenReady`, and that ordering is load-bearing: Electron reads the
  // privileged-scheme table when the protocol subsystem starts, so a call made
  // after ready is silently ignored and every plugin module 404s with nothing
  // in the log to say why.
  registerPluginScheme()

  app.whenReady().then(async () => {
    enableCodexDiagnostics()
    // Now that the subsystem is up, attach the handler that actually serves
    // plugin files (and the runtime shims) out of `~/jingler/plugins`.
    registerPluginProtocolHandler()

    // Hand the host service its Electron-shaped pieces. No process is spawned
    // here — the first activation event does that, which is the whole point of
    // lazy activation.
    await runtime.runPromise(
      installPluginHost(spawnHostProcess, nativeConsentPrompt, makeHostRequestHandler)
    )
    // Force the layer to build so the RPC server + `ipcMain` listener are live
    // before the renderer can send its first frame.
    await runtime.runPromise(Effect.void)
    // Not awaited — the catalogue warms in the background while the window opens.
    void runtime.runPromise(prefetchModels)

    // Themes, before the window. Both of these have to happen ahead of
    // `createWindow` or the first frame is painted in the wrong theme: the
    // background colour is read by `BrowserWindow` at construction, and the
    // preload pulls the stylesheet synchronously as the document starts. Never
    // normally resolves failures to One Dark Pro. Keep the await behind one
    // final launch-boundary catch too: a defect in the fallback path must not
    // prevent the window from being created.
    registerBootThemeChannel()
    try {
      themeBackgroundColor = bootBackgroundColor(await resolveBootTheme())
    } catch (cause) {
      console.error("Could not prepare the boot theme; using One Dark Pro.", cause)
    }

    createWindow()

    // Self-update only makes sense in a packaged build (dev has no update feed).
    if (app.isPackaged) initAutoUpdater()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", () => {
    // The extension host is a utilityProcess; Electron reaps it with the app,
    // but killing it explicitly means a plugin mid-`exec` gets torn down in the
    // same pass as the PTYs below rather than racing the app's own exit.
    void runtime.runPromise(PluginHost.shutdown()).catch(() => {})
    // Nothing we spawned is reaped when the main process exits — POSIX reparents
    // orphans to init and they live forever. Two families of child, killed the
    // same way for the same reason:
    //
    //  - harness subprocesses — `opencode serve`, `codex app-server` — which each
    //    spawn site cleans up on its own happy path, but NOT when the app quits
    //    mid-flight. That gap leaked one `opencode serve` per e2e test, since the
    //    suite tears down Electron once per test while the model catalogue is
    //    still being fetched.
    //  - PTYs, which live in their own session.
    //
    // BOTH synchronous, and the PTYs especially so. `runtime.dispose()` below may
    // never get the chance to run to completion, and an orphaned server outlives
    // the app either way — but the PTYs are worse than a leak. Reclaiming them
    // through the runtime (`runPromise(TerminalService.killAll)`) is a PROMISE, so
    // this handler returned and Electron tore the Node environment down with
    // shells still open; node-pty's reader thread then fired a ThreadSafeFunction
    // into an environment already in `CleanupHandles()`, which napi refuses, which
    // node-addon-api throws, which nothing catches: SIGABRT out of `pty.node`
    // instead of a clean quit. See `killAllPtysSync` for the long version.
    killAllChildren()
    killAllPtysSync()
    void runtime.dispose()
  })
}
