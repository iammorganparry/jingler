import { DurableObject } from "cloudflare:workers"
import {
  readBoundedJson,
  workerFields as fields,
  workerJson as json
} from "@jingler/core/worker-http"
import { openCredential, sealCredential } from "./credential-envelope.js"
import {
  emptyAuthState,
  removeExpired,
  resolveCredential,
  snapshotOf,
  type AuthSession,
  type AuthStateRecord,
  type CapabilityUpstream,
  type CapabilityProvider,
  type StoredCredential
} from "./state.js"

interface AuthStateEnv {
  readonly AUTH_STATE: DurableObjectNamespace<AuthStateObject>
  readonly AUTH_STATE_SERVICE_SECRET: string
  readonly MANAGED_RUNTIME_CALLBACK_SECRET: string
  readonly MANAGED_RUNTIME_ORIGIN: string
  readonly AUTH_STATE_ENCRYPTION_KEY: string
}

interface Subscriber {
  readonly id: string
  readonly callbackUrl: string
  readonly leaseExpiresAt: number
}

const STATE_KEY = "auth-state"
const SUBSCRIBER_KEY = "managed-subscriber"
const SUBSCRIPTION_SECONDS = 5 * 60
const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    return fields(await readBoundedJson(request))
  } catch {
    return null
  }
}

const nowSeconds = (): number => Math.floor(Date.now() / 1_000)

const credentialFingerprint = async (
  authorizationHeader: string,
  upstream: CapabilityUpstream,
  accountId: string | null
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${upstream}\n${accountId ?? ""}\n${authorizationHeader}`)
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

const providerOf = (value: unknown): CapabilityProvider | null =>
  value === "github" || value === "codex" || value === "claude" ? value : null

const upstreamOf = (
  provider: CapabilityProvider,
  value: unknown
): CapabilityUpstream | null => {
  if (provider === "github") return value === undefined || value === "github-api" ? "github-api" : null
  if (provider === "codex") {
    return value === undefined || value === "openai-api"
      ? "openai-api"
      : value === "chatgpt-codex"
        ? value
        : null
  }
  return value === undefined || value === "anthropic-api" ? "anthropic-api" : null
}

const authorized = (request: Request, env: AuthStateEnv): boolean =>
  env.AUTH_STATE_SERVICE_SECRET.length >= 32 &&
  (request.headers.get("x-jingler-service-secret") === env.AUTH_STATE_SERVICE_SECRET ||
    request.headers.get("authorization") === `Bearer ${env.AUTH_STATE_SERVICE_SECRET}`)

const subjectPath = (
  pathname: string
): { subject: string; suffix: string } | null => {
  const match = pathname.match(/^\/v1\/internal\/users\/([^/]+)(\/.*)?$/u)
  if (match === null) return null
  try {
    return {
      subject: decodeURIComponent(match[1] ?? ""),
      suffix: match[2] ?? ""
    }
  } catch {
    return null
  }
}

/** Deterministically-routed per-user auth state; no account scans or polling. */
export class AuthStateObject extends DurableObject<AuthStateEnv> {
  async #state(subject: string): Promise<AuthStateRecord> {
    const stored = await this.ctx.storage.get<AuthStateRecord>(STATE_KEY)
    if (stored !== undefined && stored.subject !== subject) {
      throw new Error("Auth-state subject mismatch")
    }
    const current = removeExpired(stored ?? emptyAuthState(subject), nowSeconds())
    if (current !== stored) await this.ctx.storage.put(STATE_KEY, current)
    return current
  }

  async #put(state: AuthStateRecord): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state)
    const expiries = [
      ...Object.values(state.sessions).map(({ expiresAt }) => expiresAt),
      ...Object.values(state.credentials)
        .filter((credential): credential is StoredCredential => credential !== undefined)
        .map(({ expiresAt }) => expiresAt)
    ].filter((expiresAt) => expiresAt > nowSeconds())
    if (expiries.length > 0) {
      await this.ctx.storage.setAlarm(Math.min(...expiries) * 1_000)
    }
  }

  async #notify(state: AuthStateRecord): Promise<void> {
    const subscriber = await this.ctx.storage.get<Subscriber>(SUBSCRIBER_KEY)
    const now = nowSeconds()
    if (subscriber === undefined || subscriber.leaseExpiresAt <= now) return
    await fetch(subscriber.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": this.env.MANAGED_RUNTIME_CALLBACK_SECRET
      },
      body: JSON.stringify({
        snapshot: snapshotOf(state, now),
        leaseExpiresAt: subscriber.leaseExpiresAt
      })
    }).catch(() => undefined)
  }

  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<AuthStateRecord>(STATE_KEY)
    if (stored === undefined) return
    const current = removeExpired(stored, nowSeconds())
    if (current !== stored) {
      await this.#put(current)
      await this.#notify(current)
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (!authorized(request, this.env)) return json({ error: "Unauthorized" }, 401)
    const url = new URL(request.url)
    const body =
      request.method === "POST" || request.method === "PUT" || request.method === "DELETE"
      ? await readBody(request)
      : null
    const subject = typeof body?.subject === "string" ? body.subject : null
    if (subject === null || subject.length === 0 || subject.length > 256) {
      return json({ error: "subject is required" }, 400)
    }
    const state = await this.#state(subject)

    if (url.pathname === "/v1/subscriptions/managed-runtime" && request.method === "POST") {
      const subscriberId = typeof body?.subscriberId === "string" ? body.subscriberId : null
      const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl : null
      if (subscriberId === null || callbackUrl === null) {
        return json({ error: "subscriberId and callbackUrl are required" }, 400)
      }
      let callback: URL
      try {
        callback = new URL(callbackUrl)
      } catch {
        return json({ error: "Invalid callback URL" }, 400)
      }
      if (callback.origin !== this.env.MANAGED_RUNTIME_ORIGIN) {
        return json({ error: "Callback origin is not allowed" }, 400)
      }
      const leaseExpiresAt = nowSeconds() + SUBSCRIPTION_SECONDS
      await this.ctx.storage.put<Subscriber>(SUBSCRIBER_KEY, {
        id: subscriberId,
        callbackUrl,
        leaseExpiresAt
      })
      return json({ snapshot: snapshotOf(state, nowSeconds()), leaseExpiresAt })
    }

    if (url.pathname === "/v1/capabilities/resolve" && request.method === "POST") {
      const provider = providerOf(body?.provider)
      const handle = typeof body?.handle === "string" ? body.handle : null
      if (
        provider === null ||
        handle === null ||
        body?.audience !== "managed-runtime-provider-proxy"
      ) {
        return json({ error: "Invalid capability request" }, 400)
      }
      const credential = resolveCredential(state, provider, handle, nowSeconds())
      return credential === null
        ? json({ error: "Capability unavailable" }, 403)
        : json({
            authorizationHeader: await openCredential(
              credential.authorizationHeaderEncrypted,
              this.env.AUTH_STATE_ENCRYPTION_KEY
            ),
            upstream: credential.upstream ??
              (credential.provider === "github" ? "github-api" : "openai-api"),
            ...(credential.accountIdEncrypted === undefined
              ? {}
              : {
                  accountId: await openCredential(
                    credential.accountIdEncrypted,
                    this.env.AUTH_STATE_ENCRYPTION_KEY
                  )
                })
          })
    }

    if (url.pathname === "/v1/internal/session" && request.method === "PUT") {
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null
      const expiresAt = typeof body?.expiresAt === "number" ? body.expiresAt : null
      if (sessionId === null || expiresAt === null || !Number.isSafeInteger(expiresAt)) {
        return json({ error: "Invalid session" }, 400)
      }
      const session: AuthSession = { id: sessionId, expiresAt }
      const next = {
        ...state,
        version: state.version + 1,
        sessions: { ...state.sessions, [sessionId]: session }
      }
      await this.#put(next)
      await this.#notify(next)
      return json({ ok: true, version: next.version })
    }

    if (url.pathname === "/v1/internal/session" && request.method === "DELETE") {
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null
      if (sessionId === null) return json({ error: "Invalid session" }, 400)
      if (state.sessions[sessionId] === undefined) {
        return json({ ok: true, version: state.version })
      }
      const { [sessionId]: _removed, ...sessions } = state.sessions
      const next = { ...state, version: state.version + 1, sessions }
      await this.#put(next)
      await this.#notify(next)
      return json({ ok: true, version: next.version })
    }

    if (url.pathname === "/v1/internal/capability" && request.method === "PUT") {
      const provider = providerOf(body?.provider)
      const upstream = provider === null ? null : upstreamOf(provider, body?.upstream)
      const authorizationHeader =
        typeof body?.authorizationHeader === "string" ? body.authorizationHeader : null
      const accountId = typeof body?.accountId === "string" ? body.accountId : null
      const expiresAt = typeof body?.expiresAt === "number" ? body.expiresAt : null
      if (
        provider === null ||
        upstream === null ||
        authorizationHeader === null ||
        !(authorizationHeader.startsWith("Bearer ") ||
          authorizationHeader.startsWith("X-Api-Key ")) ||
        expiresAt === null ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= nowSeconds()
      ) {
        return json({ error: "Invalid capability" }, 400)
      }
      if (
        (upstream === "chatgpt-codex" &&
          (accountId === null || !/^[0-9a-f-]{36}$/iu.test(accountId))) ||
        (upstream !== "chatgpt-codex" && accountId !== null)
      ) {
        return json({ error: "Invalid capability scope" }, 400)
      }
      const fingerprint = await credentialFingerprint(authorizationHeader, upstream, accountId)
      const existing = state.credentials[provider]
      if (
        existing?.fingerprint === fingerprint &&
        existing.expiresAt > nowSeconds() + 6 * 60 * 60
      ) {
        return json({ ok: true, version: state.version, handle: existing.handle })
      }
      const credential: StoredCredential = {
        provider,
        handle:
          existing?.fingerprint === fingerprint
            ? existing.handle
            : `capability_${crypto.randomUUID().replaceAll("-", "")}`,
        fingerprint,
        upstream,
        authorizationHeaderEncrypted: await sealCredential(
          authorizationHeader,
          this.env.AUTH_STATE_ENCRYPTION_KEY
        ),
        ...(accountId === null
          ? {}
          : {
              accountIdEncrypted: await sealCredential(
                accountId,
                this.env.AUTH_STATE_ENCRYPTION_KEY
              )
            }),
        expiresAt
      }
      const next = {
        ...state,
        version: state.version + 1,
        credentials: { ...state.credentials, [provider]: credential }
      }
      await this.#put(next)
      await this.#notify(next)
      return json({ ok: true, version: next.version, handle: credential.handle })
    }

    if (url.pathname === "/v1/internal/capability" && request.method === "DELETE") {
      const provider = providerOf(body?.provider)
      if (provider === null) return json({ error: "Invalid capability" }, 400)
      if (state.credentials[provider] === undefined) {
        return json({ ok: true, version: state.version })
      }
      const { [provider]: _removed, ...credentials } = state.credentials
      const next = { ...state, version: state.version + 1, credentials }
      await this.#put(next)
      await this.#notify(next)
      return json({ ok: true, version: next.version })
    }

    return json({ error: "Not found" }, 404)
  }
}

export default {
  async fetch(request: Request, env: AuthStateEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return json({ status: "ok", service: "@jingler/auth-state" })
    }
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401)
    const parsed = subjectPath(new URL(request.url).pathname)
    if (parsed === null || parsed.subject.length === 0 || parsed.subject.length > 256) {
      return json({ error: "Not found" }, 404)
    }
    return env.AUTH_STATE.getByName(parsed.subject).fetch(
      `https://auth-state.internal/v1/internal${parsed.suffix}`,
      {
        method: request.method,
        headers: {
          "content-type": "application/json",
          "x-jingler-service-secret": env.AUTH_STATE_SERVICE_SECRET
        },
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : JSON.stringify({ ...(await readBody(request)), subject: parsed.subject })
      }
    )
  }
}
