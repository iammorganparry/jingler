/**
 * A dev-only loopback sign-in callback. On macOS the OS can't route the
 * `jingler://` custom scheme to an UNpackaged Electron (it launches a fresh,
 * app-less Electron instead — see `deep-link.ts`), so `pnpm dev` can never
 * receive the auth deep link. Instead we listen on `http://127.0.0.1:<port>`
 * and hand that URL to the auth flow as its callback; the server's
 * `/desktop/callback` route 302s the bearer token here, and we deliver it
 * through the SAME path as a real deep link.
 *
 * Bound to 127.0.0.1 (never a routable interface), on an ephemeral port, and
 * gated by a random `state` nonce so another local process can't post a forged
 * token. The listener is created only in dev (`!app.isPackaged`).
 */
import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AuthCallback, GitHubCallback } from "./deep-link.js"

export interface AuthLoopback {
  /** The full callback URL — `http://127.0.0.1:<port>/callback?state=<nonce>`. */
  readonly url: string
  /** Stop listening. Idempotent. */
  readonly close: () => void
}

const page = (message: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Jingler</title></head>` +
  `<body style="font:14px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh">` +
  `<p>${message}</p></body></html>`

/**
 * Start the loopback listener. `deliver` receives the same `AuthCallback` a
 * deep link would — the caller wires it to the token-storing path.
 */
export const startAuthLoopback = (
  deliver: (callback: AuthCallback) => void,
  deliverGitHub: (callback: GitHubCallback) => void = () => {},
  createHttpServer: typeof createServer = createServer
): Promise<AuthLoopback> =>
  new Promise((resolve, reject) => {
    const state = randomBytes(16).toString("hex")
    const server: Server = createHttpServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1")
      if (requestUrl.pathname !== "/callback") {
        res.writeHead(404).end()
        return
      }
      // A mismatched/absent nonce is a forged or stale hit — ignore it entirely.
      if (requestUrl.searchParams.get("state") !== state) {
        res.writeHead(403, { "content-type": "text/html" }).end(page("Invalid sign-in state."))
        return
      }
      const github = requestUrl.searchParams.get("github")
      const token = requestUrl.searchParams.get("token")
      if (github !== null) {
        deliverGitHub({
          connected: github === "connected",
          error: github === "connected" ? null : (requestUrl.searchParams.get("error") ?? "callback")
        })
      } else {
        deliver({ token, error: requestUrl.searchParams.get("error") })
      }
      res.writeHead(200, { "content-type": "text/html" }).end(
        page(
          github === "connected"
            ? "GitHub connected. You can close this tab and return to Jingler."
            : token
            ? "Signed in. You can close this tab and return to Jingler."
            : github !== null
              ? "GitHub connection failed. You can close this tab and try again in Jingler."
              : "Sign-in failed. You can close this tab and try again in Jingler."
        )
      )
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/callback?state=${state}`,
        close: () => server.close()
      })
    })
  })
