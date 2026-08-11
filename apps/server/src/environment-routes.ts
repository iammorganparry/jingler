import type {
  Environment,
  ManagedEnvironment,
  ManagedEnvironmentGrantRequest as ManagedEnvironmentGrantRequestValue,
  ManagedEnvironmentLifecycleRequest as ManagedEnvironmentLifecycleRequestValue
} from "@jingler/core"
import {
  CreateManagedEnvironmentRequest,
  DeleteManagedEnvironmentRequest,
  EnvironmentInventoryResponse,
  ManagedEnvironmentGrantRequest,
  ManagedEnvironmentGrantResponse,
  ManagedEnvironmentLifecycleRequest,
  RenameManagedEnvironmentRequest,
  WorkspaceProvisioningPlan
} from "@jingler/core"
import crypto from "node:crypto"
import { Schema } from "effect"
import { Hono } from "hono"
import { getAuth } from "./auth.js"
import { loadAccountDevicesForUser } from "./device-routes.js"
import {
  ManagedEnvironmentRepository,
  type CreateManagedEnvironmentInput
} from "./db/repositories/managed-environment-repository.js"
import {
  ManagedUsageRepository,
  type ManagedUsageReservationResult
} from "./db/repositories/managed-usage-repository.js"
import { env } from "./env.js"
import {
  deleteAuthStateCapability,
  type AuthCapabilityUpstream,
  upsertAuthStateCapability
} from "./auth-state-client.js"
import { managedGitHubCapabilityForUser } from "./github-routes.js"
import { decodeBoundedJson } from "./request-decoding.js"
import { runtime } from "./runtime.js"

const noStoreHeaders = { "cache-control": "no-store" } as const
const MANAGED_CLOUD_IDEMPOTENCY_KEY = "account_cloud_v1"

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStoreHeaders })

class ManagedRuntimeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const runtimeError = async (
  response: Response,
  fallback: string
): Promise<ManagedRuntimeRequestError> => {
  const body: unknown = await response.json().catch(() => null)
  return new ManagedRuntimeRequestError(
    response.status,
    typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
      ? body.error
      : fallback
  )
}

interface OwnedInventoryEntry {
  readonly environment: Environment
  readonly createdAt: number
}

export interface ManagedEnvironmentStore {
  readonly create: (input: CreateManagedEnvironmentInput) => Promise<ManagedEnvironment>
  readonly findForUser: (
    userId: string,
    environmentId: string
  ) => Promise<ManagedEnvironment | null>
  readonly renameForUser: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly displayName: string
    readonly at: Date
  }) => Promise<ManagedEnvironment | null>
  readonly setStateForUser: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly state: ManagedEnvironment["state"]
    readonly expectedGeneration: number
    readonly at: Date
  }) => Promise<ManagedEnvironment | null>
  readonly deleteForUser: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly expectedGeneration: number
    readonly at: Date
  }) => Promise<ManagedEnvironment | null>
}

export interface EnvironmentRoutesDependencies {
  readonly enabled: boolean
  readonly now: () => Date
  readonly getUserId: (headers: Headers) => Promise<string | null>
  readonly listOwned: (userId: string) => Promise<ReadonlyArray<OwnedInventoryEntry>>
  readonly managedHarnesses?: (userId: string) => Promise<ReadonlyArray<"codex" | "claude">>
  readonly syncCapabilities?: (input: {
    readonly userId: string
    readonly codexCredential: {
      readonly authorizationHeader: string
      readonly upstream: AuthCapabilityUpstream
      readonly accountId?: string
      readonly expiresAt: Date
    } | null
    readonly claudeCredential: {
      readonly authorizationHeader: string
      readonly upstream: "anthropic-api"
      readonly expiresAt: Date
    } | null
    readonly includeGitHub: boolean
  }) => Promise<void>
  readonly store: ManagedEnvironmentStore
  readonly issueGrant: (input: {
    readonly userId: string
    readonly environment: ManagedEnvironment
    readonly request: ManagedEnvironmentGrantRequestValue
    readonly reservationId: string | null
  }) => Promise<ManagedEnvironmentGrantResponse>
  readonly reserveStart?: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly sessionId: string
    readonly usageIntervalId: string
  }) => Promise<ManagedUsageReservationResult>
  readonly releaseStart?: (input: {
    readonly userId: string
    readonly reservationId: string
  }) => Promise<void>
  readonly destroyEnvironment?: (input: {
    readonly userId: string
    readonly environmentId: string
  }) => Promise<void>
  readonly destroySession?: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly sessionId: string
  }) => Promise<void>
  readonly releaseSessionStart?: (input: {
    readonly userId: string
    readonly environmentId: string
    readonly sessionId: string
  }) => Promise<void>
  readonly hydrateWorkspace?: (input: {
    readonly userId: string
    readonly environment: ManagedEnvironment
    readonly sessionId: string
    readonly plan: Schema.Schema.Type<typeof WorkspaceProvisioningPlan>
  }) => Promise<void>
}

const persistentStore: ManagedEnvironmentStore = {
  create: (input) => runtime.runPromise(ManagedEnvironmentRepository.create(input)),
  findForUser: (userId, environmentId) =>
    runtime.runPromise(ManagedEnvironmentRepository.findForUser(userId, environmentId)),
  renameForUser: (input) =>
    runtime.runPromise(ManagedEnvironmentRepository.renameForUser(input)),
  setStateForUser: (input) =>
    runtime.runPromise(ManagedEnvironmentRepository.setStateForUser(input)),
  deleteForUser: (input) =>
    runtime.runPromise(ManagedEnvironmentRepository.deleteForUser(input))
}

const defaultDependencies = (): EnvironmentRoutesDependencies => ({
  enabled: env.managedEnvironmentsEnabled,
  now: () => new Date(),
  getUserId: async (headers) => {
    const session = await getAuth().api.getSession({ headers }).catch(() => null)
    return session?.user?.id ?? null
  },
  listOwned: async (userId) => {
    const devices = await loadAccountDevicesForUser(userId)
    return devices.map((device) => ({
      createdAt: device.createdAt,
      environment: {
        kind: "owned",
        id: device.deviceId,
        name: device.displayName,
        platform: device.platform,
        capabilities: device.capabilities,
        state:
          device.state === "revoked"
            ? "revoked"
            : !device.capabilities.capabilities.includes("session.start")
              ? "incompatible"
              : device.presence.state,
        agentVersion: device.agentVersion ?? null,
        lastSeenAt: device.presence.lastSeenAt
      }
    }))
  },
  managedHarnesses: async (userId) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/account-capabilities/${encodeURIComponent(userId)}`,
      { headers: { authorization: `Bearer ${env.managedRuntimeServiceSecret}` } }
    )
    if (!response.ok) return []
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null || !("harnesses" in body)) return []
    if (!Array.isArray(body.harnesses)) return []
    return body.harnesses.filter(
      (harness): harness is "codex" | "claude" => harness === "codex" || harness === "claude"
    )
  },
  syncCapabilities: async ({ userId, codexCredential, claudeCredential, includeGitHub }) => {
    const config = {
      enabled: env.managedEnvironmentsEnabled,
      url: env.authStateUrl,
      serviceSecret: env.authStateServiceSecret
    }
    const github = includeGitHub
      ? await managedGitHubCapabilityForUser(userId)
      : undefined
    await Promise.all([
      codexCredential === null
        ? deleteAuthStateCapability(config, { userId, provider: "codex" })
        : upsertAuthStateCapability(config, {
            userId,
            provider: "codex",
            ...codexCredential
          }),
      claudeCredential === null
        ? deleteAuthStateCapability(config, { userId, provider: "claude" })
        : upsertAuthStateCapability(config, {
            userId,
            provider: "claude",
            ...claudeCredential
          }),
      github === undefined
        ? Promise.resolve()
        : github === null
          ? deleteAuthStateCapability(config, { userId, provider: "github" })
          : upsertAuthStateCapability(config, {
              userId,
              provider: "github",
              ...github
            })
    ])
  },
  store: persistentStore,
  issueGrant: async (input) => {
    const response = await fetch(`${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/grants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        version: 1,
        subject: input.userId,
        environmentId: input.environment.id,
        environmentGeneration: input.environment.generation,
        sessionId: input.request.sessionId,
        reservationId: input.reservationId,
        actions: input.request.actions
      })
    })
    if (!response.ok) throw await runtimeError(response, "Managed runtime rejected the grant")
    return Schema.decodeUnknownSync(ManagedEnvironmentGrantResponse)(await response.json(), {
      onExcessProperty: "error"
    })
  },
  reserveStart: (input) => runtime.runPromise(ManagedUsageRepository.reserve({
    id: `usage_${crypto.randomUUID().replaceAll("-", "")}`,
    userId: input.userId,
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    idempotencyKey: `managed-interval:${input.sessionId}:${input.usageIntervalId}`,
    policy: {
      maxConcurrentSessions: env.managedMaxConcurrentSessions,
      maxActiveSeconds: env.managedMaxActiveSeconds,
      dailyBudgetMicrousd: env.managedDailyBudgetMicrousd,
      maxEgressBytes: env.managedMaxEgressBytes,
      maxCheckpointBytes: env.managedMaxCheckpointBytes,
      checkpointRetentionSeconds: env.managedCheckpointRetentionSeconds
    },
    now: new Date()
  })),
  releaseStart: (input) => runtime.runPromise(ManagedUsageRepository.release({
    userId: input.userId,
    reservationId: input.reservationId,
    now: new Date()
  })),
  destroyEnvironment: async (input) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/environments/destroy`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          subject: input.userId,
          environmentId: input.environmentId
        })
      }
    )
    if (!response.ok) throw await runtimeError(response, "Managed environment cleanup failed")
  },
  destroySession: async (input) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/sessions/destroy`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          subject: input.userId,
          environmentId: input.environmentId,
          sessionId: input.sessionId
        })
      }
    )
    if (!response.ok) throw await runtimeError(response, "Managed session cleanup failed")
  },
  releaseSessionStart: (input) =>
    runtime.runPromise(ManagedUsageRepository.releaseReservedForSession({
      ...input,
      now: new Date()
    })),
  hydrateWorkspace: async (input) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/workspaces/hydrate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          version: 1,
          subject: input.userId,
          environmentId: input.environment.id,
          environmentGeneration: input.environment.generation,
          sessionId: input.sessionId,
          plan: input.plan,
          repositoryUrl: `https://github.com/${input.plan.repository.slug}.git`
        })
      }
    )
    if (!response.ok) throw await runtimeError(response, "Managed workspace hydration failed")
  }
})

const ManagedWorkspaceRequest = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  expectedGeneration: Schema.Int.pipe(Schema.positive()),
  plan: WorkspaceProvisioningPlan
})

const boundedCredential = (value: string): string | null =>
  value.length >= 20 &&
  value.length <= 4_096 &&
  [...value].every((character) => {
    const code = character.charCodeAt(0)
    return code >= 33 && code <= 126
  })
    ? value
    : null

const jwtExpiry = (token: string): number | null => {
  const encoded = token.split(".")[1]
  if (encoded === undefined) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      exp?: unknown
    }
    return typeof payload.exp === "number" && Number.isSafeInteger(payload.exp)
      ? payload.exp
      : null
  } catch {
    return null
  }
}

const codexCredentialFrom = (
  request: Request
): {
  readonly authorizationHeader: string
  readonly upstream: AuthCapabilityUpstream
  readonly accountId?: string
  readonly expiresAt: Date
} | null => {
  const value = request.headers.get("x-jingler-codex-api-key")?.trim() ?? ""
  const apiKey = boundedCredential(value)
  if (apiKey !== null) {
    return {
      authorizationHeader: `Bearer ${apiKey}`,
      upstream: "openai-api",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000)
    }
  }
  const accessToken = boundedCredential(
    request.headers.get("x-jingler-codex-access-token")?.trim() ?? ""
  )
  const accountId = request.headers.get("x-jingler-codex-account-id")?.trim() ?? ""
  const expiresAt = accessToken === null ? null : jwtExpiry(accessToken)
  const now = Math.floor(Date.now() / 1_000)
  if (
    accessToken === null ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/iu.test(accountId) ||
    expiresAt === null ||
    expiresAt <= now + 60
  ) {
    return null
  }
  return {
    authorizationHeader: `Bearer ${accessToken}`,
    upstream: "chatgpt-codex",
    accountId,
    expiresAt: new Date(Math.min(expiresAt, now + 24 * 60 * 60) * 1_000)
  }
}

const claudeCredentialFrom = (
  request: Request
): {
  readonly authorizationHeader: string
  readonly upstream: "anthropic-api"
  readonly expiresAt: Date
} | null => {
  const apiKey = boundedCredential(
    request.headers.get("x-jingler-claude-api-key")?.trim() ?? ""
  )
  const accessToken = boundedCredential(
    request.headers.get("x-jingler-claude-access-token")?.trim() ?? ""
  )
  const rawExpiresAt = Number(request.headers.get("x-jingler-claude-expires-at") ?? 0)
  const now = Math.floor(Date.now() / 1_000)
  if (apiKey !== null) {
    return {
      authorizationHeader: `X-Api-Key ${apiKey}`,
      upstream: "anthropic-api",
      expiresAt: new Date((now + 24 * 60 * 60) * 1_000)
    }
  }
  if (
    accessToken === null ||
    !Number.isSafeInteger(rawExpiresAt) ||
    rawExpiresAt <= now + 60
  ) {
    return null
  }
  return {
    authorizationHeader: `Bearer ${accessToken}`,
    upstream: "anthropic-api",
    expiresAt: new Date(Math.min(rawExpiresAt, now + 24 * 60 * 60) * 1_000)
  }
}

/**
 * Cloud is an account-scoped execution target, not a user-managed machine.
 * The stable opaque id keeps sessions and checkpoints addressable without
 * exposing the account id or requiring an inventory row before first use.
 */
export const managedCloudIdForUser = (userId: string): string =>
  `managed_cloud_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32)}`

const managedCloudCapabilities = (
  harnesses: ReadonlyArray<"codex" | "claude">
): ManagedEnvironment["capabilities"] => ({
  version: 1,
  capabilities: [
    "session.start",
    "session.input",
    "session.cancel",
    "session.observe"
  ],
  harnesses: [...harnesses],
  maxConcurrentSessions: 1
})

const managedCloudEnvironment = (
  userId: string,
  harnesses: ReadonlyArray<"codex" | "claude">
): ManagedEnvironment => ({
  kind: "managed",
  id: managedCloudIdForUser(userId),
  name: "Cloud",
  platform: { os: "linux", arch: "x64" },
  capabilities: managedCloudCapabilities(harnesses),
  state: "online",
  agentVersion: null,
  lastSeenAt: null,
  region: null,
  instanceType: "basic",
  generation: 1,
  createdAt: 0,
  updatedAt: 0
})

const ensureManagedCloudEnvironment = async (
  dependencies: EnvironmentRoutesDependencies,
  userId: string,
  harnesses: ReadonlyArray<"codex" | "claude"> = []
): Promise<ManagedEnvironment> => {
  const environmentId = managedCloudIdForUser(userId)
  const existing = await dependencies.store.findForUser(userId, environmentId)
  if (existing) {
    return {
      ...existing,
      name: "Cloud",
      state: "online",
      capabilities: managedCloudCapabilities(harnesses)
    }
  }
  const created = await dependencies.store.create({
    id: environmentId,
    userId,
    displayName: "Cloud",
    region: null,
    instanceType: "basic",
    capabilities: managedCloudCapabilities(harnesses),
    idempotencyKey: MANAGED_CLOUD_IDEMPOTENCY_KEY,
    at: dependencies.now()
  })
  return {
    ...created,
    name: "Cloud",
    state: "online",
    capabilities: managedCloudCapabilities(harnesses)
  }
}

const lifecycleState = (
  action: ManagedEnvironmentLifecycleRequestValue["action"]
): ManagedEnvironment["state"] => {
  switch (action) {
    case "start":
      return "provisioning"
    case "pause":
      return "paused"
    case "restore":
      return "restoring"
  }
}

export const createEnvironmentRoutes = (
  dependenciesFactory: () => EnvironmentRoutesDependencies = defaultDependencies
) => {
  const routes = new Hono()

  const authenticate = async (request: Request, dependencies: EnvironmentRoutesDependencies) =>
    dependencies.getUserId(request.headers)

  routes.get("/", async (context) => {
    const dependencies = dependenciesFactory()
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    try {
      if (!dependencies.enabled) {
        const owned = await dependencies.listOwned(userId)
        return json(
          Schema.decodeUnknownSync(EnvironmentInventoryResponse)({
            version: 1,
            environments: [...owned]
              .sort(
                (left, right) =>
                  left.createdAt - right.createdAt ||
                  left.environment.id.localeCompare(right.environment.id)
              )
              .map((entry) => entry.environment)
          })
        )
      }
      const owned = await dependencies.listOwned(userId)
      const environments = [
        ...[...owned].sort(
          (left, right) =>
            left.createdAt - right.createdAt ||
            left.environment.id.localeCompare(right.environment.id)
        ).map((entry) => entry.environment),
        managedCloudEnvironment(userId, ["codex", "claude"])
      ]
      return json(
        Schema.decodeUnknownSync(EnvironmentInventoryResponse)({
          version: 1,
          environments
        })
      )
    } catch {
      return json({ error: "Environment inventory unavailable" }, 503)
    }
  })

  routes.post("/managed", async (context) => {
    const dependencies = dependenciesFactory()
    if (!dependencies.enabled) return json({ error: "Managed environments disabled" }, 404)
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    const input = await decodeBoundedJson(context.req.raw, CreateManagedEnvironmentRequest)
    if (!input) return json({ error: "Invalid managed environment request" }, 400)
    try {
      await dependencies.syncCapabilities?.({
        userId,
        codexCredential: codexCredentialFrom(context.req.raw),
        claudeCredential: claudeCredentialFrom(context.req.raw),
        includeGitHub: true
      })
      const harnesses = await (dependencies.managedHarnesses?.(userId) ?? Promise.resolve([]))
      if (harnesses.length === 0) {
        return json({
          error: "Managed Cloud requires a local Codex or Claude login and an active GitHub connection"
        }, 409)
      }
      const environment = await ensureManagedCloudEnvironment(
        dependencies,
        userId,
        harnesses
      )
      return json({ version: 1, environment })
    } catch {
      return json({ error: "Managed environment creation unavailable" }, 503)
    }
  })

  routes.post("/managed/:environmentId/rename", async (context) => {
    const dependencies = dependenciesFactory()
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    if (context.req.param("environmentId") === managedCloudIdForUser(userId)) {
      return json({ error: "Cloud is managed automatically" }, 409)
    }
    const input = await decodeBoundedJson(context.req.raw, RenameManagedEnvironmentRequest)
    if (!input) return json({ error: "Invalid rename request" }, 400)
    const environment = await dependencies.store.renameForUser({
      userId,
      environmentId: context.req.param("environmentId"),
      displayName: input.name.trim(),
      at: dependencies.now()
    }).catch(() => null)
    return environment
      ? json({ version: 1, environment })
      : json({ error: "Managed environment not found" }, 404)
  })

  routes.post("/managed/:environmentId/lifecycle", async (context) => {
    const dependencies = dependenciesFactory()
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    if (context.req.param("environmentId") === managedCloudIdForUser(userId)) {
      return json({ error: "Cloud sandboxes follow the session lifecycle" }, 409)
    }
    const input = await decodeBoundedJson(
      context.req.raw,
      ManagedEnvironmentLifecycleRequest
    )
    if (!input) return json({ error: "Invalid lifecycle request" }, 400)
    if (input.action === "pause" && dependencies.destroyEnvironment) {
      try {
        await dependencies.destroyEnvironment({
          userId,
          environmentId: context.req.param("environmentId")
        })
      } catch (cause) {
        return cause instanceof ManagedRuntimeRequestError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed environment cleanup failed" }, 503)
      }
    }
    const environment = await dependencies.store.setStateForUser({
      userId,
      environmentId: context.req.param("environmentId"),
      state: lifecycleState(input.action),
      expectedGeneration: input.expectedGeneration,
      at: dependencies.now()
    }).catch(() => null)
    return environment
      ? json({ version: 1, environment })
      : json({ error: "Managed environment generation changed" }, 409)
  })

  routes.post("/managed/:environmentId/workspaces", async (context) => {
    const dependencies = dependenciesFactory()
    if (!dependencies.enabled) return json({ error: "Managed environments disabled" }, 404)
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    const input = await decodeBoundedJson(context.req.raw, ManagedWorkspaceRequest)
    if (!input) return json({ error: "Invalid workspace request" }, 400)
    if (context.req.param("environmentId") !== managedCloudIdForUser(userId)) {
      return json({ error: "Managed environment not found" }, 404)
    }
    const environment = await ensureManagedCloudEnvironment(dependencies, userId)
      .catch(() => null)
    if (!environment) return json({ error: "Managed environment not found" }, 404)
    if (environment.generation !== input.expectedGeneration) {
      return json({ error: "Managed environment generation changed" }, 409)
    }
    if (!dependencies.hydrateWorkspace) {
      return json({ error: "Managed workspace hydration unavailable" }, 503)
    }
    try {
      await dependencies.syncCapabilities?.({
        userId,
        codexCredential: codexCredentialFrom(context.req.raw),
        claudeCredential: claudeCredentialFrom(context.req.raw),
        includeGitHub: true
      })
      await dependencies.hydrateWorkspace({
        userId,
        environment,
        sessionId: input.sessionId,
        plan: input.plan
      })
      await dependencies.store.setStateForUser({
        userId,
        environmentId: environment.id,
        state: "online",
        expectedGeneration: environment.generation,
        at: dependencies.now()
      })
      return json({ version: 1, hydrated: true })
    } catch (cause) {
      return cause instanceof ManagedRuntimeRequestError
        ? json({ error: cause.message }, cause.status)
        : json({ error: "Managed workspace hydration failed" }, 503)
    }
  })

  routes.post("/managed/:environmentId/sessions/:sessionId/delete", async (context) => {
    const dependencies = dependenciesFactory()
    if (!dependencies.enabled) return json({ error: "Managed environments disabled" }, 404)
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    const environmentId = context.req.param("environmentId")
    const sessionId = context.req.param("sessionId")
    if (environmentId !== managedCloudIdForUser(userId)) {
      return json({ error: "Managed environment not found" }, 404)
    }
    if (!dependencies.destroySession) {
      return json({ error: "Managed session cleanup unavailable" }, 503)
    }
    try {
      await dependencies.destroySession({ userId, environmentId, sessionId })
      await dependencies.releaseSessionStart?.({ userId, environmentId, sessionId })
      return json({ version: 1, deleted: true })
    } catch (cause) {
      return cause instanceof ManagedRuntimeRequestError
        ? json({ error: cause.message }, cause.status)
        : json({ error: "Managed session cleanup failed" }, 503)
    }
  })

  routes.post("/managed/:environmentId/delete", async (context) => {
    const dependencies = dependenciesFactory()
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    if (context.req.param("environmentId") === managedCloudIdForUser(userId)) {
      return json({ error: "Cloud is managed automatically" }, 409)
    }
    const input = await decodeBoundedJson(context.req.raw, DeleteManagedEnvironmentRequest)
    if (!input) return json({ error: "Invalid delete request" }, 400)
    const current = await dependencies.store.findForUser(
      userId,
      context.req.param("environmentId")
    ).catch(() => null)
    if (!current) return json({ error: "Managed environment not found" }, 404)
    if (current.generation !== input.expectedGeneration) {
      return json({ error: "Managed environment generation changed" }, 409)
    }
    if (dependencies.destroyEnvironment) {
      try {
        await dependencies.destroyEnvironment({
          userId,
          environmentId: current.id
        })
      } catch (cause) {
        return cause instanceof ManagedRuntimeRequestError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed environment cleanup failed" }, 503)
      }
    }
    const environment = await dependencies.store.deleteForUser({
      userId,
      environmentId: context.req.param("environmentId"),
      expectedGeneration: input.expectedGeneration,
      at: dependencies.now()
    }).catch(() => null)
    return environment ? json({ version: 1 }) : json({ error: "Managed environment not found" }, 404)
  })

  routes.post("/managed/:environmentId/grants", async (context) => {
    const dependencies = dependenciesFactory()
    if (!dependencies.enabled) return json({ error: "Managed environments disabled" }, 404)
    const userId = await authenticate(context.req.raw, dependencies)
    if (!userId) return json({ error: "Authentication required" }, 401)
    const request = await decodeBoundedJson(context.req.raw, ManagedEnvironmentGrantRequest)
    if (!request) return json({ error: "Invalid managed grant request" }, 400)
    if (context.req.param("environmentId") !== managedCloudIdForUser(userId)) {
      return json({ error: "Managed environment not found" }, 404)
    }
    const environment = await ensureManagedCloudEnvironment(dependencies, userId)
      .catch(() => null)
    if (!environment) return json({ error: "Managed environment not found" }, 404)
    if (environment.generation !== request.expectedGeneration) {
      return json({ error: "Managed environment generation changed" }, 409)
    }
    const metered = request.actions.some(
      (action) => action === "session.start" || action === "session.input"
    )
    if (metered) {
      try {
        await dependencies.syncCapabilities?.({
          userId,
          codexCredential: codexCredentialFrom(context.req.raw),
          claudeCredential: claudeCredentialFrom(context.req.raw),
          includeGitHub: false
        })
      } catch {
        return json({ error: "Managed authorization sync unavailable" }, 503)
      }
    }
    const reservation = metered && dependencies.reserveStart
      ? await dependencies.reserveStart({
          userId,
          environmentId: environment.id,
          sessionId: request.sessionId,
          usageIntervalId: request.usageIntervalId
        }).catch(() => null)
      : null
    if (metered && dependencies.reserveStart && reservation === null) {
      return json({ error: "Managed usage budget is temporarily unavailable" }, 503)
    }
    if (reservation?.status === "denied") {
      return json({
        error: reservation.reason === "concurrency"
          ? "Only one managed session can run at a time"
          : "The daily managed-compute budget has been reached"
      }, 429)
    }
    try {
      return json(await dependencies.issueGrant({
        userId,
        environment,
        request,
        reservationId: reservation?.reservationId ?? null
      }))
    } catch (cause) {
      if (reservation?.status === "reserved" && dependencies.releaseStart) {
        await dependencies.releaseStart({
          userId,
          reservationId: reservation.reservationId
        }).catch(() => undefined)
      }
      return cause instanceof ManagedRuntimeRequestError
        ? json({ error: cause.message }, cause.status)
        : json({ error: "Managed runtime unavailable" }, 503)
    }
  })

  return routes
}
