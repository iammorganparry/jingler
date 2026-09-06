/**
 * The desktop-side auth seam. `AuthService` mediates between the OS keychain
 * (`SecretStore`, holding the bearer token) and the `@jingler/server` BetterAuth
 * backend. The renderer drives it through the `Auth.*` RPCs:
 *   - `getSession` — validate the stored token against the server (clearing it if
 *     invalid/expired), returning the user or null.
 *   - `startSignIn` — ask the server for the provider's OAuth URL (the renderer
 *     opens it in the system browser; the flow returns via the `jingler://`
 *     deep link handled in the main process).
 *   - `sendMagicLink` — request an email magic link.
 *   - `signOut` — revoke on the server (best effort) and clear the local token.
 *
 * The token is never logged and only ever read from / written to `SecretStore`.
 */
import type { AuthProvider, AuthSession } from "@jingler/core"
import { AuthError } from "@jingler/core"
import { Effect, Schema } from "effect"
import { SecretStore, type SecretStoreShape } from "./secret-store.js"

/** Base URL of the auth backend. Overridable (prod deploy, e2e fake server). */
const authBaseUrl = (): string => process.env.JINGLER_AUTH_URL ?? "http://localhost:9100"

/**
 * Where the browser flow bounces back to. Always the server's `/desktop/callback`
 * bridge (same origin — no trusted-origins change needed). In dev the main
 * process sets `JINGLER_DEV_AUTH_LOOPBACK` to a `http://127.0.0.1:<port>` URL it
 * listens on; we pass it as a `redirect` the bridge honours (loopback only), so
 * the token lands over HTTP instead of the macOS-unroutable `jingler://` link.
 */
const desktopCallback = (base: string): string => {
  const target = `${base}/desktop/callback`
  const loopback = process.env.JINGLER_DEV_AUTH_LOOPBACK
  return loopback ? `${target}?redirect=${encodeURIComponent(loopback)}` : target
}

interface SessionResponse {
  readonly session?: { readonly expiresAt?: string } | null
  readonly user?:
    | { readonly id: string; readonly email: string; readonly name?: string; readonly image?: string | null }
    | null
}

const SignInResponse = Schema.Struct({ url: Schema.String })
const AuthServerErrorResponse = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String)
})

const decodeResponse = <A, I>(
  response: Response,
  schema: Schema.Schema<A, I>,
  message: string
): Effect.Effect<A, AuthError> =>
  Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: () => new AuthError({ message })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.mapError(() => new AuthError({ message }))
  )

export class AuthService extends Effect.Service<AuthService>()("@jingler/AuthService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const secrets = yield* SecretStore

    /** Validate the stored token; null when signed out, invalid, or unreachable. */
    const getSession = (): Effect.Effect<AuthSession | null> =>
      Effect.gen(function* () {
        const token = yield* secrets.get
        return yield* validateStoredAuthToken(token, secrets)
      })

    /** POST to the auth server, mapping transport failure to a user-facing `AuthError`. */
    const post = (path: string, payload: unknown): Effect.Effect<Response, AuthError> =>
      Effect.tryPromise({
        try: () =>
          fetch(`${authBaseUrl()}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }),
        catch: () => new AuthError({ message: "Couldn't reach the sign-in service." })
      })

    /** Get the provider OAuth URL to open in the system browser. */
    const startSignIn = (provider: AuthProvider): Effect.Effect<string, AuthError> =>
      Effect.gen(function* () {
        const res = yield* post("/api/auth/sign-in/social", {
          provider,
          callbackURL: desktopCallback(authBaseUrl())
        })
        if (!res.ok) {
          const serverError = yield* decodeResponse(
            res,
            AuthServerErrorResponse,
            "The sign-in service rejected the request."
          ).pipe(Effect.option)
          if (serverError._tag === "Some" && serverError.value.code === "PROVIDER_NOT_FOUND") {
            const label = provider === "github" ? "GitHub" : "Google"
            return yield* Effect.fail(
              new AuthError({ message: `${label} sign-in is unavailable. Use email instead.` })
            )
          }
          return yield* Effect.fail(
            new AuthError({ message: "The sign-in service rejected the request." })
          )
        }
        const body = yield* decodeResponse(res, SignInResponse, "Unexpected sign-in response.")
        return body.url
      })

    /**
     * Request a magic-link email. `name` is passed through only for sign-up (the
     * server applies it as the display name when creating a new user; BetterAuth
     * ignores it for existing accounts).
     */
    const sendMagicLink = (email: string, name?: string): Effect.Effect<void, AuthError> =>
      Effect.gen(function* () {
        const response = yield* post("/api/auth/sign-in/magic-link", {
          email,
          ...(name ? { name } : {}),
          callbackURL: desktopCallback(authBaseUrl())
        })
        if (!response.ok) {
          return yield* Effect.fail(
            new AuthError({ message: "The sign-in service rejected the request." })
          )
        }
      })

    /** Revoke on the server (best effort) and always clear the local token. */
    const signOut = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const token = yield* secrets.get
        if (token) {
          yield* Effect.tryPromise(() =>
            fetch(`${authBaseUrl()}/api/auth/sign-out`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` }
            })
          ).pipe(Effect.ignore)
        }
        yield* secrets.clear
      })

    return { getSession, startSignIn, sendMagicLink, signOut } as const
  })
}) {}

function* validateStoredAuthToken(token: string | null, secrets: SecretStoreShape) {
  if (!token) return null
  const base = authBaseUrl()
  const res = yield* Effect.tryPromise(() =>
    fetch(`${base}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${token}` }
    })
  ).pipe(Effect.orElseSucceed(() => null))
  // Network error → keep the token, stay signed out for now (transient).
  if (!res) return null
  // Unauthorized → the token is dead; clear it so we stop retrying.
  if (res.status === 401) {
    yield* secrets.clear
    return null
  }
  if (!res.ok) return null
  const body = yield* Effect.tryPromise(() => res.json() as Promise<SessionResponse>).pipe(
    Effect.orElseSucceed(() => null)
  )
  if (!body?.session || !body.user) {
    yield* secrets.clear
    return null
  }
  return {
    user: {
      id: body.user.id,
      email: body.user.email,
      name: body.user.name ?? "",
      image: body.user.image ?? null
    },
    expiresAt: body.session.expiresAt ?? ""
  }
}
