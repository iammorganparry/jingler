/**
 * `jingler://` deep-link plumbing. The browser sign-in flow ends by redirecting
 * to `jingler://auth/callback?token=…` (or `?error=…`); the OS routes that to
 * this app. Delivery differs per platform:
 *   - macOS: the `open-url` event (even while running).
 *   - Windows/Linux: the URL arrives as a `process.argv` entry, via the
 *     `second-instance` event when already running, or the initial argv on a
 *     cold start.
 *
 * The parsing helpers are pure so they can be unit-tested without Electron.
 */
import path from "node:path"
import { app } from "electron"

export const AUTH_PROTOCOL = "jingler"
/** IPC channel the main process uses to tell the renderer a sign-in resolved. */
export const AUTH_COMPLETE_CHANNEL = "jingler/auth-complete"
/** Dedicated channel for GitHub App callbacks (never a BetterAuth sign-in). */
export const GITHUB_COMPLETE_CHANNEL = "jingler/github-complete"

export interface AuthCallback {
  readonly token: string | null
  readonly error: string | null
}

export interface GitHubCallback {
  readonly connected: boolean
  readonly error: string | null
}

/**
 * Parse a `jingler://auth/callback?token=…|error=…` URL. Returns null when the
 * URL isn't our auth callback (wrong scheme/host or unparseable).
 */
export const parseAuthCallback = (raw: string): AuthCallback | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${AUTH_PROTOCOL}:`) return null
  if (url.host !== "auth") return null
  if (url.searchParams.has("github")) return null
  return { token: url.searchParams.get("token"), error: url.searchParams.get("error") }
}

/** Parse the GitHub App result carried over the existing desktop bridge. */
export const parseGitHubCallback = (raw: string): GitHubCallback | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${AUTH_PROTOCOL}:` || url.host !== "auth") return null
  const result = url.searchParams.get("github")
  if (result === null) return null
  return {
    connected: result === "connected",
    error: result === "connected" ? null : (url.searchParams.get("error") ?? "callback")
  }
}

/** Find the first `jingler://…` deep link in a process argv array. */
export const findDeepLinkInArgv = (argv: ReadonlyArray<string>): string | null =>
  argv.find((arg) => arg.startsWith(`${AUTH_PROTOCOL}://`)) ?? null

/** Register this app as the OS handler for the `jingler://` scheme. */
export const registerProtocolClient = (): void => {
  // In dev, Electron runs via `electron .`, so the launcher + script path must be
  // passed explicitly for the OS to re-invoke us with the right arguments.
  const script = process.argv[1]
  if (process.defaultApp && script) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [path.resolve(script)])
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL)
  }
}
