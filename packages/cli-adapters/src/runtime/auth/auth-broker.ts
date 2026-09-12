import { createHash } from "node:crypto"
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai"
import {
  authStatusForObservedBillingRoute,
  ProviderConnectionId,
  ProviderId,
  type AuthKind,
  type ProviderConnection,
  type SubscriptionStatus
} from "@jingler/core"
import { Context, Data, Effect, Ref, Schema } from "effect"
import type { ProviderCredentialStore, StoredProviderCredential } from "./credential-store.js"
import { codexAccountIdFromAccessToken } from "./codex-access-token.js"

export interface OAuthCredential {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

export interface OAuthInteraction {
  readonly signal: AbortSignal
  readonly prompt: (prompt: AuthPrompt) => Promise<string>
  readonly notify: (event: AuthEvent) => void
}

export interface CodexOAuthFlow {
  readonly login: (interaction: OAuthInteraction) => Promise<OAuthCredential>
  readonly refresh: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>
}

export interface EntitlementProbeResult {
  readonly entitlement: SubscriptionStatus["entitlement"]
  readonly planLabel: string | null
  readonly quotaLabel: string | null
  readonly rateLimitLabel: string | null
  readonly billingRoute: "subscription" | "api" | "device-environment" | null
  /** Successful provider request route, stripped of credentials and query data. */
  readonly observedRoute: string
}

export interface AuthBrokerOptions {
  readonly credentials: ProviderCredentialStore
  readonly codexOAuth: CodexOAuthFlow
  readonly probe: (input: {
    readonly providerId: string
    readonly authKind: AuthKind
    readonly access: string
    readonly signal: AbortSignal
  }) => Promise<EntitlementProbeResult>
  readonly now?: () => number
  readonly refreshSkewMs?: number
}

export class AuthBrokerError extends Data.TaggedError("AuthBrokerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Renderer-safe cause detail: no secrets, bounded length, single line. */
export const describeCause = (cause: unknown): string | null => {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const sanitized = raw
    .replace(/\s+/gu, " ")
    .replace(/(?:sk|rt|oat|pat)[-_][\w-]{8,}[\w.-]*/gu, "[redacted]")
    .replace(/Bearer\s+\S+/gu, "Bearer [redacted]")
    .replace(/\b[\w-]{20,}\.[\w-]{20,}\.[\w-]{10,}\b/gu, "[redacted]")
    .trim()
  if (sanitized.length === 0) return null
  return sanitized.length > 300 ? `${sanitized.slice(0, 300)}…` : sanitized
}

const withCause = (message: string, cause: unknown): string => {
  const detail = describeCause(cause)
  return detail === null ? message : `${message}: ${detail}`
}

const brokerPromise = <A>(message: string, operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new AuthBrokerError({ message: withCause(message, cause), cause })
  })

const brokerSync = <A>(message: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) => new AuthBrokerError({ message: withCause(message, cause), cause })
  })

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12)

const decodeConnectionId = (value: string) =>
  brokerSync("Invalid provider connection id", () =>
    Schema.decodeUnknownSync(ProviderConnectionId)(value)
  )
const decodeProviderId = (value: string) =>
  brokerSync("Invalid provider id", () =>
    Schema.decodeUnknownSync(ProviderId)(value)
  )

export interface AuthBrokerShape {
  readonly list: Effect.Effect<ReadonlyArray<ProviderConnection>>
  readonly get: (
    id: ProviderConnectionId
  ) => Effect.Effect<ProviderConnection | null>
  readonly restore: (
    connections: ReadonlyArray<ProviderConnection>
  ) => Effect.Effect<void>
  readonly setApiKey: (input: {
    readonly id: string
    readonly provider: string
    readonly apiKey: string
    readonly targetId: string
    readonly signal?: AbortSignal
  }) => Effect.Effect<ProviderConnection, AuthBrokerError>
  readonly connectClaudeToken: (input: {
    readonly id: string
    readonly token: string
    readonly targetId: string
    readonly signal?: AbortSignal
  }) => Effect.Effect<ProviderConnection, AuthBrokerError>
  readonly startCodexLogin: (input: {
    readonly id: string
    readonly targetId: string
    readonly prompt: OAuthInteraction["prompt"]
    readonly notify: OAuthInteraction["notify"]
  }) => Effect.Effect<ProviderConnection, AuthBrokerError>
  readonly cancelLogin: (id: ProviderConnectionId) => Effect.Effect<void>
  readonly resolve: (id: ProviderConnectionId) => Effect.Effect<
    {
      readonly connection: ProviderConnection
      readonly access: string
      readonly expiresAt: number | null
      readonly accountId: string | null
    },
    AuthBrokerError
  >
  readonly refresh: (
    id: ProviderConnectionId
  ) => Effect.Effect<ProviderConnection, AuthBrokerError>
  readonly logout: (
    id: ProviderConnectionId
  ) => Effect.Effect<void, AuthBrokerError>
  /** Irreversibly removes a partially-created connection and its credential. */
  readonly delete: (
    id: ProviderConnectionId
  ) => Effect.Effect<void, AuthBrokerError>
}

export class AuthBroker extends Context.Tag("@jingler/AuthBroker")<
  AuthBroker,
  AuthBrokerShape
>() {}

const hasCurrentClaudeCliCredential = (
  connection: ProviderConnection,
  credential: StoredProviderCredential | null
): boolean =>
  connection.authKind !== "claude-setup-token" || (
    credential?.authKind === "claude-setup-token" &&
    credential.access === "claude-cli" &&
    connection.subscription.observedRoute === "claude-cli:subscription"
  )

interface ConnectionInput {
  readonly id: ProviderConnectionId
  readonly provider: string
  readonly targetId: string
  readonly credential: StoredProviderCredential
  readonly signal?: AbortSignal
}

class LiveAuthBroker implements AuthBrokerShape {
  constructor(
    private readonly options: AuthBrokerOptions,
    private readonly connections: Ref.Ref<
      Map<ProviderConnectionId, ProviderConnection>
    >,
    private readonly logins: Ref.Ref<
      Map<ProviderConnectionId, AbortController>
    >,
    private readonly refreshLock: Effect.Semaphore
  ) {}

  get list(): Effect.Effect<ReadonlyArray<ProviderConnection>> {
    return Ref.get(this.connections).pipe(
      Effect.map((current) => [...current.values()])
    )
  }

  get = (id: ProviderConnectionId) =>
    Ref.get(this.connections).pipe(
      Effect.map((current) => current.get(id) ?? null)
    )

  restore = (restored: ReadonlyArray<ProviderConnection>) =>
    Effect.forEach(
      restored,
      (connection) =>
        connection.status === "disconnected"
          ? Effect.succeed(connection)
          : this.options.credentials.read(connection.id).pipe(
              Effect.map((credential) =>
                credential !== null &&
                credential.authKind === connection.authKind &&
                hasCurrentClaudeCliCredential(connection, credential)
                  ? connection
                  : {
                      ...connection,
                      status: "reauthentication-required" as const,
                      updatedAt: new Date(this.now()).toISOString()
                    }
              ),
              Effect.catchAll(() =>
                Effect.succeed({
                  ...connection,
                  status: "reauthentication-required" as const,
                  updatedAt: new Date(this.now()).toISOString()
                })
              )
            ),
      { concurrency: "unbounded" }
    ).pipe(
      Effect.flatMap((connections) =>
        Ref.update(this.connections, (current) => {
          const next = new Map(current)
          for (const connection of connections) next.set(connection.id, connection)
          return next
        })
      )
    )

  setApiKey: AuthBrokerShape["setApiKey"] = (input) =>
    Effect.gen(this, function* () {
      const access = input.apiKey.trim()
      if (access.length === 0) return yield* this.fail("API key is required")
      const id = yield* decodeConnectionId(input.id)
      const credential: StoredProviderCredential = {
        connectionId: id,
        authKind: "api-key",
        access,
        refresh: null,
        expiresAt: null
      }
      const connection = yield* this.probe({
        id,
        provider: input.provider,
        targetId: input.targetId,
        credential,
        signal: input.signal
      })
      if (connection.subscription.confirmedBillingRoute !== "api") {
        return yield* this.fail("Provider did not confirm the API billing route")
      }
      yield* this.writeCredential(credential)
      return yield* this.remember(connection)
    })

  connectClaudeToken: AuthBrokerShape["connectClaudeToken"] = (input) =>
    Effect.gen(this, function* () {
      const access = "claude-cli"
      const id = yield* decodeConnectionId(input.id)
      return yield* this.connect({
        id,
        provider: "anthropic",
        targetId: input.targetId,
        credential: {
          connectionId: id,
          authKind: "claude-setup-token",
          access,
          refresh: null,
          expiresAt: null
        },
        signal: input.signal
      })
    })

  startCodexLogin: AuthBrokerShape["startCodexLogin"] = (input) =>
    Effect.gen(this, function* () {
      const id = yield* decodeConnectionId(input.id)
      const controller = new AbortController()
      const claimed = yield* Ref.modify(this.logins, (current) => {
        if (current.has(id)) return [false, current]
        const next = new Map(current)
        next.set(id, controller)
        return [true, next]
      })
      if (!claimed) return yield* this.fail("Login is already in progress")

      return yield* this.login(id, input, controller).pipe(
        Effect.ensuring(this.forgetLogin(id))
      )
    })

  cancelLogin = (id: ProviderConnectionId) =>
    Ref.get(this.logins).pipe(
      Effect.flatMap((current) =>
        Effect.sync(() => current.get(id)?.abort("cancelled"))
      )
    )

  resolve: AuthBrokerShape["resolve"] = (id) =>
    Effect.gen(this, function* () {
      const connection = yield* this.requireConnection(id)
      if (connection.status !== "authenticated") {
        return yield* this.fail("Reauthentication required")
      }
      const stored = yield* this.readCredential(id)
      if (
        stored === null ||
        stored.authKind !== connection.authKind ||
        !hasCurrentClaudeCliCredential(connection, stored)
      ) {
        return yield* this.fail("Reauthentication required")
      }
      const credential = yield* this.refreshIfNeeded(stored)
      return {
        connection,
        access: credential.access,
        expiresAt: credential.expiresAt,
        accountId:
          connection.providerId === "openai-codex"
            ? codexAccountIdFromAccessToken(credential.access)
            : null
      }
    })

  refresh: AuthBrokerShape["refresh"] = (id) =>
    Effect.gen(this, function* () {
      const current = yield* this.requireConnection(id)
      const stored = yield* this.readCredential(id)
      if (
        stored === null ||
        (current.authKind === "claude-setup-token" && (
          current.status !== "authenticated" ||
          !hasCurrentClaudeCliCredential(current, stored)
        ))
      ) return yield* this.fail("Reauthentication required")
      const credential = yield* this.refreshIfNeeded(stored)
      const connection = yield* this.probe({
        id,
        provider: current.providerId,
        targetId: current.targetId,
        credential
      })
      return yield* this.remember(connection)
    })

  logout: AuthBrokerShape["logout"] = (id) =>
    Effect.gen(this, function* () {
      yield* this.cancelLogin(id)
      yield* this.deleteCredential(id)
      yield* Ref.update(this.connections, (current) => {
        const connection = current.get(id)
        if (connection === undefined) return current
        const next = new Map(current)
        next.set(id, {
          ...connection,
          status: "disconnected",
          updatedAt: new Date(this.now()).toISOString()
        })
        return next
      })
    })

  delete: AuthBrokerShape["delete"] = (id) =>
    Effect.gen(this, function* () {
      yield* this.cancelLogin(id)
      yield* this.deleteCredential(id)
      yield* Ref.update(this.connections, (current) => {
        if (!current.has(id)) return current
        const next = new Map(current)
        next.delete(id)
        return next
      })
    })

  private login(
    id: ProviderConnectionId,
    input: Parameters<AuthBrokerShape["startCodexLogin"]>[0],
    controller: AbortController
  ) {
    return Effect.gen(this, function* () {
      const oauth = yield* brokerPromise(
        "Failed to connect Codex subscription",
        () =>
          this.options.codexOAuth.login({
            signal: controller.signal,
            prompt: input.prompt,
            notify: input.notify
          })
      )
      return yield* this.connect({
        id,
        provider: "openai-codex",
        targetId: input.targetId,
        credential: {
          connectionId: id,
          authKind: "openai-codex-oauth",
          access: oauth.access,
          refresh: oauth.refresh,
          expiresAt: oauth.expires
        },
        signal: controller.signal
      })
    })
  }

  private connect(input: ConnectionInput) {
    return Effect.gen(this, function* () {
      const connection = yield* this.probe(input)
      yield* this.writeCredential(input.credential)
      return yield* this.remember(connection)
    })
  }

  private probe(input: ConnectionInput) {
    return Effect.gen(this, function* () {
      const result = yield* brokerPromise(
        "Failed to verify provider entitlement",
        () =>
          this.options.probe({
            providerId: input.provider,
            authKind: input.credential.authKind,
            access: input.credential.access,
            signal: input.signal ?? new AbortController().signal
          })
      )
      const provider = yield* decodeProviderId(input.provider)
      return this.connectionFromProbe(input, provider, result)
    })
  }

  private connectionFromProbe(
    input: ConnectionInput,
    provider: ProviderId,
    result: EntitlementProbeResult
  ): ProviderConnection {
    const timestamp = new Date(this.now()).toISOString()
    return {
      id: input.id,
      providerId: provider,
      authKind: input.credential.authKind,
      account: {
        fingerprint: fingerprint(input.credential.access),
        displayLabel: result.planLabel
      },
      targetId: input.targetId,
      status: authStatusForObservedBillingRoute(
        input.credential.authKind,
        result.entitlement,
        result.billingRoute
      ),
      subscription: {
        entitlement: result.entitlement,
        planLabel: result.planLabel,
        expiresAt:
          input.credential.expiresAt === null
            ? null
            : new Date(input.credential.expiresAt).toISOString(),
        quotaLabel: result.quotaLabel,
        rateLimitLabel: result.rateLimitLabel,
        confirmedBillingRoute: result.billingRoute,
        observedRoute: result.observedRoute.trim()
      },
      createdAt: timestamp,
      updatedAt: timestamp
    }
  }

  private refreshIfNeeded(credential: StoredProviderCredential) {
    return this.needsRefresh(credential)
      ? this.refreshCredential(credential)
      : Effect.succeed(credential)
  }

  private refreshCredential(credential: StoredProviderCredential) {
    return this.refreshLock.withPermits(1)(
      Effect.gen(this, function* () {
        const latest = yield* this.readCredential(credential.connectionId)
        if (latest === null) return yield* this.fail("Reauthentication required")
        if (!this.needsRefresh(latest)) return latest
        if (latest.refresh === null) {
          return yield* this.fail("Reauthentication required")
        }
        const refreshed = yield* brokerPromise(
          "Failed to refresh Codex subscription",
          () =>
            this.options.codexOAuth.refresh(
              {
                access: latest.access,
                refresh: latest.refresh ?? "",
                expires: latest.expiresAt ?? 0
              },
              new AbortController().signal
            )
        )
        const stored: StoredProviderCredential = {
          ...latest,
          access: refreshed.access,
          refresh: refreshed.refresh,
          expiresAt: refreshed.expires
        }
        yield* this.writeCredential(stored)
        return stored
      })
    )
  }

  private readCredential(id: ProviderConnectionId) {
    return this.options.credentials.read(id).pipe(
      Effect.mapError((cause) =>
        new AuthBrokerError({
          message: "Failed to read provider credentials",
          cause
        })
      )
    )
  }

  private writeCredential(credential: StoredProviderCredential) {
    return this.options.credentials.write(credential).pipe(
      Effect.mapError((cause) =>
        new AuthBrokerError({
          message: "Failed to persist provider credentials",
          cause
        })
      )
    )
  }

  private deleteCredential(id: ProviderConnectionId) {
    return this.options.credentials.delete(id).pipe(
      Effect.mapError((cause) =>
        new AuthBrokerError({
          message: "Failed to delete provider credentials",
          cause
        })
      )
    )
  }

  private requireConnection(id: ProviderConnectionId) {
    return Effect.gen(this, function* () {
      const connection = yield* this.get(id)
      return connection ?? (yield* this.fail("Provider connection not found"))
    })
  }

  private remember(connection: ProviderConnection) {
    return Ref.update(this.connections, (current) => {
      const next = new Map(current)
      next.set(connection.id, connection)
      return next
    }).pipe(Effect.as(connection))
  }

  private forgetLogin(id: ProviderConnectionId) {
    return Ref.update(this.logins, (current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }

  private needsRefresh(credential: StoredProviderCredential): boolean {
    return (
      credential.authKind === "openai-codex-oauth" &&
      credential.expiresAt !== null &&
      credential.expiresAt <= this.now() + this.refreshSkew()
    )
  }

  private fail(message: string) {
    return Effect.fail(new AuthBrokerError({ message }))
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private refreshSkew(): number {
    return this.options.refreshSkewMs ?? 5 * 60 * 1_000
  }
}

export const makeAuthBroker = (
  options: AuthBrokerOptions
): Effect.Effect<AuthBrokerShape> =>
  Effect.gen(function* () {
    const connections = yield* Ref.make(
      new Map<ProviderConnectionId, ProviderConnection>()
    )
    const logins = yield* Ref.make(
      new Map<ProviderConnectionId, AbortController>()
    )
    const refreshLock = yield* Effect.makeSemaphore(1)
    return new LiveAuthBroker(options, connections, logins, refreshLock)
  })
