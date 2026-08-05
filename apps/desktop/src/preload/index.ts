/**
 * Preload bridge. Exposes a minimal, safe surface on `window.jingler` that only
 * shuttles opaque RPC frames between the renderer's `RpcClient` and the main
 * process's `RpcServer`. No business logic lives here — see `src/main/rpc.ts`.
 */
import { contextBridge, ipcRenderer } from "electron"

const RPC_CHANNEL = "jingler/rpc"
const AUTH_COMPLETE_CHANNEL = "jingler/auth-complete"
const GITHUB_COMPLETE_CHANNEL = "jingler/github-complete"
const NOTIFICATION_ACTIVATED_CHANNEL = "jingler/notification-activated"
const BOOT_THEME_CHANNEL = "jingler/boot-theme"
// Must match the preview channels in main/preview-view.ts (kept as literals
// here so the preload doesn't import the main bundle).
const PREVIEW_REVEAL_CHANNEL = "jingler/preview/reveal"
const PREVIEW_URL_CHANNEL = "jingler/preview/url"
const PLAN_FLUSH_REQUEST_CHANNEL = "jingler/plan-flush-request"
const PLAN_FLUSH_COMPLETE_CHANNEL = "jingler/plan-flush-complete"

/**
 * The active theme's `:root` block, fetched SYNCHRONOUSLY at preload time.
 *
 * `sendSync` is normally the wrong tool — it blocks the renderer process — and
 * here that is exactly the requirement. `main.tsx` injects this before
 * `createRoot`, so the document's first paint already carries the operator's
 * theme. Doing it asynchronously means the browser paints at least one frame
 * from the One Dark fallback in `globals.css` first, which on a light theme is
 * a full dark flash on every launch.
 *
 * The cost is one already-computed string crossing a process boundary once per
 * launch; main pre-resolves it during `whenReady`, so nothing touches disk on
 * this path. An empty string means "main had no answer" — the fallback block
 * then applies, which is the pre-theming behaviour and strictly better than a
 * hung window.
 */
const initialThemeCss: string = (() => {
  try {
    return (ipcRenderer.sendSync(BOOT_THEME_CHANNEL) as string) ?? ""
  } catch {
    return ""
  }
})()

interface AuthCompletePayload {
  readonly ok: boolean
  readonly error: string | null
}

contextBridge.exposeInMainWorld("jingler", {
  /** The active theme's `:root` block, for `main.tsx` to inject pre-paint. */
  initialThemeCss,
  /** Ship one client→server RPC frame to main. */
  send: (data: unknown) => ipcRenderer.send(RPC_CHANNEL, data),
  /** Subscribe to server→client RPC frames; returns an unsubscribe fn. */
  on: (cb: (data: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
    ipcRenderer.on(RPC_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RPC_CHANNEL, listener)
  },
  /** Open an http(s) URL in the user's default browser (not an Electron window). */
  openExternal: (url: string) => ipcRenderer.invoke("jingler/open-external", url),
  /**
   * Subscribe to `jingler://` sign-in completions (the deep-link callback landed
   * and the token was stored). Returns an unsubscribe fn. The renderer re-checks
   * the session on `ok`.
   */
  onAuthComplete: (cb: (payload: AuthCompletePayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AuthCompletePayload) =>
      cb(payload)
    ipcRenderer.on(AUTH_COMPLETE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(AUTH_COMPLETE_CHANNEL, listener)
  },
  /** Subscribe to GitHub App callbacks without waking the BetterAuth machine. */
  onGithubComplete: (cb: (payload: AuthCompletePayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AuthCompletePayload) =>
      cb(payload)
    ipcRenderer.on(GITHUB_COMPLETE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(GITHUB_COMPLETE_CHANNEL, listener)
  },
  /**
   * Subscribe to notification clicks. Main has already focused the window; the
   * payload names the session the operator was told about, so the renderer can
   * select it. Returns an unsubscribe fn.
   */
  onNotificationActivated: (cb: (payload: { readonly sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { readonly sessionId: string }) =>
      cb(payload)
    ipcRenderer.on(NOTIFICATION_ACTIVATED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(NOTIFICATION_ACTIVATED_CHANNEL, listener)
  },
  /**
   * Subscribe to "an agent is driving the embedded browser — open the Preview
   * dock onto it". Fires on every BrowserControl op with the native view's URL
   * so QA is watchable and the visible address bar stays truthful. Returns an
   * unsubscribe fn.
   */
  onPreviewReveal: (cb: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => cb(url)
    ipcRenderer.on(PREVIEW_REVEAL_CHANNEL, listener)
    return () => ipcRenderer.removeListener(PREVIEW_REVEAL_CHANNEL, listener)
  },
  /**
   * Subscribe to committed main-frame URL changes from the embedded browser.
   * Unlike a reveal, this only synchronizes chrome and never changes dock focus.
   */
  onPreviewUrlChanged: (cb: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => cb(url)
    ipcRenderer.on(PREVIEW_URL_CHANNEL, listener)
    return () => ipcRenderer.removeListener(PREVIEW_URL_CHANNEL, listener)
  },
  onPlanFlushRequested: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on(PLAN_FLUSH_REQUEST_CHANNEL, listener)
    return () => ipcRenderer.removeListener(PLAN_FLUSH_REQUEST_CHANNEL, listener)
  },
  planFlushComplete: () => ipcRenderer.send(PLAN_FLUSH_COMPLETE_CHANNEL)
})
