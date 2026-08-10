import { clipboard, shell } from "electron"
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai"
import {
  AgentSecretStore,
  AppPaths,
  type CodexOAuthFlow,
  type EntitlementProbeResult,
  FileModelCertificationStore,
  discoverPiModels,
  makeAuthBroker,
  makePiCodexOAuthFlow,
  makeProviderCatalogService,
  makeProviderConnections,
  probePiEntitlement,
  ProviderConnections,
  ProviderConnectionsError,
  SecretStore
} from "@jingler/cli-adapters"
import {
  CURRENT_RUNTIME_CONTRACTS,
  type CodexLoginMethod,
  type ModelCertification
} from "@jingler/core"
import { Effect, Layer } from "effect"
import {
  e2eCertification,
  e2eDiscoveredModel,
  e2eProviderConnection,
  loadE2ePiFixture
} from "./e2e/pi-fixture.js"

const HTTP_URL = /^https?:\/\//i

const openExternal = (url: string): void => {
  if (HTTP_URL.test(url)) shell.openExternal(url).catch(() => undefined)
}

const waitForCancellation = (signal?: AbortSignal): Promise<string> =>
  new Promise((_, reject) => {
    const cancelled = () => reject(new Error("Login prompt cancelled"))
    if (signal?.aborted) return cancelled()
    signal?.addEventListener("abort", cancelled, { once: true })
  })

const loginPrompt =
  (method: CodexLoginMethod) =>
  (prompt: AuthPrompt): Promise<string> => {
    switch (prompt.type) {
      case "select":
        return Promise.resolve(method === "device-code" ? "device_code" : "browser")
      case "manual_code":
        return waitForCancellation(prompt.signal)
      default:
        return Promise.reject(new Error(`Unsupported Codex login prompt: ${prompt.type}`))
    }
  }

const loginNotification = (event: AuthEvent): void => {
  switch (event.type) {
    case "auth_url":
      openExternal(event.url)
      break
    case "device_code":
      clipboard.writeText(event.userCode)
      openExternal(event.verificationUri)
      break
    default:
      break
  }
}

const incompleteCertification = (
  providerId: string,
  modelId: string,
  authKind: ModelCertification["authRoute"]["kind"]
): ModelCertification => ({
  providerId,
  modelId,
  authRoute: {
    kind: authKind,
    observedRoute: authKind,
    subscription:
      authKind === "claude-setup-token" || authKind === "openai-codex-oauth",
    entitlementConfirmed: true,
    apiBillingFallbackObserved: false
  },
  versions: CURRENT_RUNTIME_CONTRACTS,
  provenance: "local",
  capabilityProfiles: [],
  results: [
    {
      scenarioId: "behavior-contract.incomplete",
      status: "failed",
      failures: ["Full PiAgentRuntime behavior verification has not run"],
      durationMs: 0,
      tokens: 0,
      costUsd: 0
    }
  ],
  certifiedAt: new Date().toISOString()
})

const e2eCodexOAuth: CodexOAuthFlow = {
  login: async ({ signal }) => {
    if (signal.aborted) throw new Error("Login cancelled")
    return {
      access: "e2e-codex-access",
      refresh: "e2e-codex-refresh",
      expires: Date.now() + 3_600_000
    }
  },
  refresh: async (_credential, signal) => {
    if (signal.aborted) throw new Error("Refresh cancelled")
    return {
      access: "e2e-codex-access-rotated",
      refresh: "e2e-codex-refresh-rotated",
      expires: Date.now() + 3_600_000
    }
  }
}

const e2eEntitlementProbe = async (input: {
  readonly authKind: ModelCertification["authRoute"]["kind"]
}): Promise<EntitlementProbeResult> => ({
  entitlement: "active",
  planLabel: input.authKind === "api-key" ? null : "Test subscription",
  quotaLabel: null,
  rateLimitLabel: null,
  billingRoute: input.authKind === "api-key" ? "api" : "subscription"
})

/** Desktop composition for explicit, encrypted, connection-pinned provider auth. */
export const ProviderConnectionsLive = Layer.effect(
  ProviderConnections,
  Effect.gen(function* () {
    const paths = yield* AppPaths
    const secretStore = yield* SecretStore
    const credentials = new AgentSecretStore(secretStore)
    const e2eFixture = loadE2ePiFixture()
    const e2eConnection = e2eFixture === null || !e2eFixture.seedConnection
      ? null
      : e2eProviderConnection(e2eFixture)
    const broker = yield* makeAuthBroker({
      credentials,
      codexOAuth: e2eFixture === null ? makePiCodexOAuthFlow() : e2eCodexOAuth,
      probe: e2eFixture === null ? probePiEntitlement : e2eEntitlementProbe
    })
    const certifications = new FileModelCertificationStore(
      paths.certificationsFile
    )
    if (e2eFixture !== null && e2eConnection !== null) {
      const connection = e2eConnection
      yield* credentials.write({
        connectionId: connection.id,
        authKind: connection.authKind,
        access: "e2e-provider-credential",
        refresh: connection.authKind === "openai-codex-oauth" ? "e2e-refresh" : null,
        expiresAt: null
      })
      yield* broker.restore([connection])
      yield* Effect.tryPromise({
        try: () => certifications.put(e2eCertification(e2eFixture)),
        catch: (cause) => new ProviderConnectionsError({
          message: "Failed to seed the e2e model certification",
          cause
        })
      })
    }
    const catalog = yield* makeProviderCatalogService({
      connections: broker.list,
      certifications,
      discover: (connection, signal) =>
        e2eFixture !== null
          ? Effect.succeed([e2eDiscoveredModel(connection.providerId)])
          : discoverPiModels(credentials, connection, signal),
      targetAvailable: (connection) => connection.targetId === "desktop"
    })
    return yield* makeProviderConnections({
      file: paths.providerConnectionsFile,
      broker,
      catalog,
      codexInteraction: (method) => ({
        prompt: loginPrompt(method),
        notify: loginNotification
      }),
      verifyModel: (input) =>
        Effect.gen(function* () {
          const connection = yield* broker.get(input.connectionId)
          if (connection === null) {
            return yield* Effect.fail(
              new ProviderConnectionsError({
                message: "Provider connection not found"
              })
            )
          }
          const certification = e2eFixture !== null
            ? e2eCertification(e2eFixture, connection.providerId, input.modelId)
            : incompleteCertification(
                connection.providerId,
                input.modelId,
                connection.authKind
              )
          yield* Effect.tryPromise({
            try: () => certifications.put(certification),
            catch: (cause) =>
              new ProviderConnectionsError({
                message: "Failed to persist model verification",
                cause
              })
          })
          return certification
        })
    })
  })
)
