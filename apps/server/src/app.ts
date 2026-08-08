/**
 * The framework-agnostic Hono app — the single source of truth for both the
 * local dev server (`src/index.ts` via `@hono/node-server`) and the Vercel
 * function (`api/[[...route]].ts` via `@hono/vercel`). Keeping the app here (and
 * the runtimes thin) means the exact same routing runs in both places.
 */
import { Effect, Option } from "effect"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { getAuth } from "./auth.js"
import { UserRepository } from "./db/repositories/user-repository.js"
import { env } from "./env.js"
import { createGitHubRoutes, isLoopbackRedirect, withQuery } from "./github-routes.js"
import { createDeviceRoutes } from "./device-routes.js"
import { proxyGitHubWebhook } from "./github-webhook-proxy.js"
import { runtime } from "./runtime.js"

export const app = new Hono()

// The desktop app calls the auth API from a `jingler://` origin (and the Vite
// dev renderer from localhost). Allow credentials so BetterAuth cookies/bearer
// round-trip.
app.use(
  "/api/*",
  cors({
    origin: ["jingler://", "http://localhost:5173", "http://localhost:9100"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true
  })
)

/** Liveness probe (Vercel + local + e2e all hit this). */
app.get("/health", (c) => c.json({ status: "ok", service: "@jingler/server" }))

/** Keep the registered App URL stable while the relay owns verification and delivery. */
app.post("/webhooks/github", (c) =>
  proxyGitHubWebhook(c.req.raw, env.githubAppRelayUrl)
)

/** BetterAuth owns everything under /api/auth/* (OAuth, magic link, session). */
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth().handler(c.req.raw))

/** Product GitHub App connection; intentionally outside BetterAuth's routes. */
app.route("/api/github", createGitHubRoutes())

/** Remote-device control. BetterAuth remains the desktop identity provider. */
app.route("/api/devices", createDeviceRoutes())

/**
 * The signed-in user's profile. BetterAuth validates the bearer session; the user
 * row is then loaded through `UserRepository` (via the Effect runtime) — the
 * canonical shape for any DB-backed endpoint we add (billing, usage, …).
 */
app.get("/api/me", async (c) => {
  const session = await getAuth().api.getSession({ headers: c.req.raw.headers }).catch(() => null)
  if (!session?.user) return c.json({ error: "Unauthorized" }, 401)
  const user = await runtime
    .runPromise(UserRepository.findById(session.user.id).pipe(Effect.map(Option.getOrNull)))
    .catch(() => null)
  if (!user) return c.json({ error: "Not found" }, 404)
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, image: user.image }
  })
})

/**
 * Only a LOOPBACK http target is honoured as a `redirect` override — never an
 * arbitrary host — so this bridge can't be turned into an open redirect that
 * exfiltrates a freshly-minted bearer token. Used by the desktop DEV loopback
 * (macOS can't route the `jingler://` scheme to an unpackaged Electron), where
 * the app listens on `http://127.0.0.1:<port>` instead of the deep link.
 */
export { isLoopbackRedirect }

/**
 * Desktop bridge. OAuth and magic-link flows complete in the user's browser,
 * where the session is a cookie the desktop app can't read. The client sets THIS
 * route as its `callbackURL`; here we read the freshly-created session server-
 * side and 302 the bearer token to the desktop. By default that is the
 * `jingler://` deep link (packaged app); a `redirect` query pointing at a
 * loopback address overrides it for dev. On failure we bounce back with an
 * `error` param so the LoginScreen can show its error state.
 */
app.get("/desktop/callback", async (c) => {
  const requested = c.req.query("redirect")
  const target = requested && isLoopbackRedirect(requested) ? requested : env.desktopRedirect
  const session = await getAuth().api
    .getSession({ headers: c.req.raw.headers })
    .catch(() => null)
  if (!session?.session?.token) {
    return c.redirect(withQuery(target, { error: "nosession" }))
  }
  return c.redirect(withQuery(target, { token: session.session.token }))
})

export default app
