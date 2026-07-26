/**
 * The pure half of the main window's navigation guards.
 *
 * Split out because the guards themselves need a live `BrowserWindow` and can
 * only be exercised by the Playwright e2e, while the decision they encode —
 * "may the renderer go here?" — is exactly the kind of thing that should be
 * pinned by cheap unit tests. A mistake here is not a broken feature; it is the
 * RPC bridge, and with it Terminal/Workspace/Auth, reachable from a page an
 * agent named.
 */

/**
 * Whether `url` may replace the current document.
 *
 * Same-ORIGIN, not same-URL: Vite's dev server does a full page reload when HMR
 * can't patch, and blocking that makes the dev loop look broken in a way nothing
 * reports. A packaged build loads over `file://`, whose origin is the opaque
 * string `"null"` for every file — so origins would compare EQUAL across the
 * whole disk, and `file:///etc/passwd` would count as same-origin. That case
 * therefore falls back to comparing the path, which is what actually
 * distinguishes one local document from another.
 *
 * Anything unparseable is refused. A URL we cannot reason about is not one we
 * should navigate to.
 */
export const sameOrigin = (url: string, current: string): boolean => {
  let target: URL
  let here: URL
  try {
    target = new URL(url)
    here = new URL(current)
  } catch {
    return false
  }
  if (target.protocol !== here.protocol) return false
  if (target.protocol === "file:") return target.pathname === here.pathname
  return target.origin === here.origin && target.origin !== "null"
}

/** Only http(s) is ever handed to the OS — `shell.openExternal` will launch ANY
 *  registered protocol handler, and an agent-authored `url` is not something to
 *  point that at. */
export const isExternallyOpenable = (url: string): boolean => /^https?:\/\//i.test(url)
