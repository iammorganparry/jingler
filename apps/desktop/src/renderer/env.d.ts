/// <reference types="vite/client" />

// The app version, inlined at build time by electron-vite (see
// electron.vite.config.ts). Available in main, preload and renderer.
declare const __APP_VERSION__: string

// The narrow, safe surface the preload bridge exposes on `window`. It only
// shuttles opaque RPC frames — no business logic lives here. See
// `src/preload/index.ts` and `src/renderer/rpc-client.ts`.
interface JinglerBridge {
  /**
   * The active theme's `:root` block, fetched synchronously by the preload so
   * `main.tsx` can inject it before the document's first paint. Empty string
   * when main had no answer — the fallback in `globals.css` then applies.
   */
  readonly initialThemeCss: string
  /** Send one client→server RPC frame to the main process. */
  readonly send: (data: unknown) => void
  /** Subscribe to server→client RPC frames. Returns an unsubscribe fn. */
  readonly on: (cb: (data: unknown) => void) => () => void
  /** Open an http(s) URL in the user's default browser. */
  readonly openExternal: (url: string) => Promise<void>
  /**
   * Subscribe to `jingler://` sign-in completions from the main process.
   * Returns an unsubscribe fn.
   */
  readonly onAuthComplete: (
    cb: (payload: { readonly ok: boolean; readonly error: string | null }) => void
  ) => () => void
  /** Subscribe to shared GitHub App completions, separately from sign-in. */
  readonly onGithubComplete: (
    cb: (payload: { readonly ok: boolean; readonly error: string | null }) => void
  ) => () => void
  /**
   * Subscribe to notification clicks. Main has already focused the window; the
   * payload names the session to select. Returns an unsubscribe fn.
   */
  readonly onNotificationActivated: (
    cb: (payload: { readonly sessionId: string }) => void
  ) => () => void
  /**
   * Subscribe to "an agent is driving the embedded browser — reveal the dock".
   * Fires on every BrowserControl op. Returns an unsubscribe fn.
   */
  readonly onPreviewReveal: (
    cb: (payload: { readonly sessionId: string; readonly url: string }) => void
  ) => () => void
  /**
   * Subscribe to committed main-frame URL changes from the embedded browser.
   * Returns an unsubscribe fn.
   */
  readonly onPreviewUrlChanged: (
    cb: (payload: { readonly sessionId: string; readonly url: string }) => void
  ) => () => void
  /** Main is waiting to close the window until dirty plan drafts are saved. */
  readonly onPlanFlushRequested: (cb: () => void) => () => void
  /** Complete the close handshake after every live plan actor settles. */
  readonly planFlushComplete: () => void
}

interface Window {
  readonly jingler: JinglerBridge
}

// `import "@jingler/ui/globals.css"` resolves to a real stylesheet that Vite
// loads; tsc just needs to know the side-effect import is a module.
declare module "*.css"
