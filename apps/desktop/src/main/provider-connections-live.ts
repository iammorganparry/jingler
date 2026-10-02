import { clipboard, shell } from "electron"
import { setTimeout as delay } from "node:timers/promises"
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
  SecretStore,
  verifyProviderModelBehavior,
  runPiScenario
} from "@jingler/cli-adapters"
import {
  BUNDLED_RELEASE_CERTIFICATION_MANIFEST,
  type CodexLoginMethod,
  type ModelCertification
} from "@jingler/core"
import { Effect, Layer } from "effect"
import {
  e2eCertification,
  e2eDiscoveredModels,
  e2eProviderConnection,
  configureE2eVerificationProvider,
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

const e2eCodexOAuth: CodexOAuthFlow = {
  login: async ({ signal, prompt, notify }) => {
    if (signal.aborted) throw new Error("Login cancelled")
    const method = await prompt({
      type: "select",
      message: "Choose a deterministic Codex login method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device_code", label: "Device code" }
      ]
    })
    if (method === "device_code") {
      notify({
        type: "device_code",
        userCode: "JING-LER1",
        verificationUri: "https://login.example.test/device",
        expiresInSeconds: 600
      })
      await delay(100, undefined, { signal })
    }
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
  billingRoute: input.authKind === "api-key" ? "api" : "subscription",
  observedRoute: `e2e-${input.authKind}`
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
    if (BUNDLED_RELEASE_CERTIFICATION_MANIFEST.models.length > 0) {
      yield* Effect.tryPromise({
        try: () =>
          certifications.putAll(
            BUNDLED_RELEASE_CERTIFICATION_MANIFEST.models
          ),
        catch: (cause) => new ProviderConnectionsError({
          message: "Failed to install bundled model certifications",
          cause
        })
      })
    }
    if (e2eFixture !== null && e2eConnection !== null) {
      const connection = e2eConnection
      yield* credentials.write({
        connectionId: connection.id,
        authKind: connection.authKind,
        access: connection.authKind === "claude-setup-token"
          ? "claude-cli"
          : "e2e-provider-credential",
        refresh: connection.authKind === "openai-codex-oauth" ? "e2e-refresh" : null,
        expiresAt: null
      })
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
        e2eFixture?.scenarioId === "pi-codex-cli-models"
          ? discoverPiModels(credentials, connection, signal)
          : e2eFixture !== null
            ? Effect.succeed(e2eDiscoveredModels(e2eFixture, connection.providerId))
            : discoverPiModels(credentials, connection, signal),
      targetAvailable: (connection) => connection.targetId === "desktop"
    })
    const service = yield* makeProviderConnections({
      file: paths.providerConnectionsFile,
      broker,
      catalog,
      codexInteraction: (method) => ({
        prompt: loginPrompt(method),
        notify: loginNotification
      }),
      verifyModel: (input) =>
        Effect.gen(function* () {
          const resolved = yield* broker.resolve(input.connectionId).pipe(
            Effect.mapError((cause) => new ProviderConnectionsError({
              message: "Provider connection could not be resolved",
              cause
            }))
          )
          const certification = yield* verifyProviderModelBehavior({
            connection: resolved.connection,
            access: resolved.access,
            credentials,
            modelId: input.modelId,
            ...(e2eFixture === null
              ? {}
              : {
                  probe: (probeInput) => e2eEntitlementProbe({
                    authKind: probeInput.authKind
                  }),
                  runScenario: (scenarioInput) => runPiScenario({
                    ...scenarioInput,
                    configureModelRuntime: configureE2eVerificationProvider(
                      scenarioInput.connection.providerId,
                      scenarioInput.scenarioId,
                      scenarioInput.connection.authKind
                    )
                  })
                })
          }).pipe(
            Effect.mapError((cause) => new ProviderConnectionsError({
              message: cause.message,
              cause
            }))
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
    // makeProviderConnections restores the persisted document during construction.
    // E2E connections are intentionally ephemeral, so install the fixture after
    // that restore rather than writing test credentials into the document.
    if (e2eConnection !== null) yield* broker.restore([e2eConnection])
    return service
  })
)
