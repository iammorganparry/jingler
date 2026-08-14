import { readFileSync } from "node:fs"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { InMemoryModelCertificationStore } from "@jingler/cli-adapters/runtime/certification/model-certification-store"
import {
  AuthKind,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderId,
  ProviderModelId,
  ReasoningEffort,
  type ModelCertification
} from "@jingler/core"
import { Effect, Option, Schema } from "effect"
import type { DeviceProviderOverrides } from "../provider-runtime.js"

const DeviceE2eEnvironment = Schema.Struct({
  JINGLER_E2E: Schema.Literal("1"),
  JINGLER_E2E_PI_FIXTURE: Schema.String.pipe(Schema.minLength(1)),
  JINGLER_E2E_PI_CONNECTION_ID: Schema.String.pipe(Schema.minLength(1)),
  JINGLER_E2E_PI_PROVIDER_ID: Schema.String.pipe(Schema.minLength(1)),
  JINGLER_E2E_PI_MODEL_ID: Schema.String.pipe(Schema.minLength(1))
})

const E2ePiFixture = Schema.Struct({
  scenarioId: Schema.String,
  authRoute: AuthKind,
  reasoning: Schema.optional(Schema.Array(ReasoningEffort)),
  seedConnection: Schema.optionalWith(Schema.Boolean, { default: () => true })
})

type DeviceE2eEnvironment = Schema.Schema.Type<typeof DeviceE2eEnvironment>
type E2ePiFixture = Schema.Schema.Type<typeof E2ePiFixture>

export interface DeviceE2ePiRuntime {
  readonly providers: DeviceProviderOverrides
  readonly configureModelRuntime: (runtime: ModelRuntime) => void
}

const certification = (
  fixture: E2ePiFixture,
  providerId: ProviderId,
  modelId: ProviderModelId
): ModelCertification => ({
  providerId,
  modelId,
  authRoute: {
    kind: fixture.authRoute,
    observedRoute: fixture.authRoute,
    subscription: fixture.authRoute !== "api-key",
    entitlementConfirmed: true,
    apiBillingFallbackObserved: false
  },
  versions: CURRENT_RUNTIME_CONTRACTS,
  provenance: "local",
  capabilityProfiles: ["core", "managed-resources"],
  results: [
    {
      scenarioId: fixture.scenarioId,
      status: "passed",
      failures: [],
      durationMs: 1,
      tokens: 0,
      costUsd: 0
    }
  ],
  certifiedAt: "2026-08-10T00:00:00.000Z"
})

const readFixture = (environment: DeviceE2eEnvironment): E2ePiFixture => {
  const source: unknown = JSON.parse(
    readFileSync(environment.JINGLER_E2E_PI_FIXTURE, "utf8")
  )
  return Schema.decodeUnknownSync(E2ePiFixture)(source)
}

/**
 * Target-local deterministic pi transport used only by Electron's remote-device
 * suite. The explicit environment contract prevents an e2e credential or model
 * from appearing in a production device process.
 */
export const loadDeviceE2ePiRuntime = (
  targetId: string,
  source: unknown = process.env
): DeviceE2ePiRuntime | null => {
  const environment = Option.getOrNull(
    Schema.decodeUnknownOption(DeviceE2eEnvironment)(source)
  )
  if (environment === null) return null

  const fixture = readFixture(environment)
  const providerId = Schema.decodeUnknownSync(ProviderId)(
    environment.JINGLER_E2E_PI_PROVIDER_ID
  )
  const modelId = Schema.decodeUnknownSync(ProviderModelId)(
    environment.JINGLER_E2E_PI_MODEL_ID
  )
  const connection = Schema.decodeUnknownSync(ProviderConnection)({
    id: environment.JINGLER_E2E_PI_CONNECTION_ID,
    providerId,
    authKind: fixture.authRoute,
    account: { fingerprint: "e2e-device", displayLabel: "Electron device fixture" },
    targetId,
    status: "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: fixture.authRoute === "api-key" ? null : "Test subscription",
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: fixture.authRoute === "api-key" ? "api" : "subscription",
      observedRoute: fixture.authRoute
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  })
  const model = {
    providerId,
    id: modelId,
    label: "Deterministic pi model",
    capabilities: {
      contextWindow: 1_000_000,
      reasoning: fixture.reasoning ?? [],
      vision: false
    }
  } as const
  const certifications = new InMemoryModelCertificationStore([
    certification(fixture, providerId, modelId)
  ])

  return {
    providers: {
      connections: [connection],
      credentialsDocument: JSON.stringify({
        agentCredentials: {
          [connection.id]: {
            authKind: connection.authKind,
            access: "e2e-device-credential",
            refresh: null,
            expiresAt: null
          }
        }
      }),
      certifications,
      discover: () => Effect.succeed([model])
    },
    configureModelRuntime: (runtime) => {
      const provider = fauxProvider({
        provider: String(providerId),
        api: "jingler-device-e2e-api",
        models: [
          {
            id: String(modelId).slice(String(providerId).length + 1),
            contextWindow: 1_000_000
          }
        ],
        tokensPerSecond: 0
      })
      provider.setResponses(
        Array.from({ length: 20 }, () =>
          fauxAssistantMessage(
            "Completed through deterministic pi. Repository summary: src/routes/billing.ts."
          )
        )
      )
      runtime.registerNativeProvider(provider.provider)
    }
  }
}
