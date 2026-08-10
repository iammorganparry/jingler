import { readFileSync } from "node:fs"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep
} from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  AuthKind,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderId,
  ProviderModelId,
  type ModelCertification
} from "@jingler/core"
import { Schema } from "effect"
import type { DiscoveredProviderModel } from "@jingler/cli-adapters"

const E2ePiFixture = Schema.Struct({
  scenarioId: Schema.String,
  authRoute: AuthKind,
  seedConnection: Schema.optionalWith(Schema.Boolean, { default: () => true })
})

export type E2ePiFixture = Schema.Schema.Type<typeof E2ePiFixture>

const PROVIDER_ID = Schema.decodeUnknownSync(ProviderId)("jingler-e2e")
const MODEL_ID = Schema.decodeUnknownSync(ProviderModelId)("jingler-e2e/eval-model")
const CONNECTION_ID = "jingler-e2e-connection"

/** Test fixtures are accepted only in an explicitly marked Electron e2e process. */
export const loadE2ePiFixture = (): E2ePiFixture | null => {
  const path = process.env.JINGLER_E2E_PI_FIXTURE
  if (process.env.JINGLER_E2E !== "1" || path === undefined) return null
  return Schema.decodeUnknownSync(E2ePiFixture)(JSON.parse(readFileSync(path, "utf8")))
}

export const e2eProviderConnection = (fixture: E2ePiFixture) =>
  Schema.decodeUnknownSync(ProviderConnection)({
    id: CONNECTION_ID,
    providerId: PROVIDER_ID,
    authKind: fixture.authRoute,
    account: { fingerprint: "e2e-account", displayLabel: "Electron fixture" },
    targetId: "desktop",
    status: "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: fixture.authRoute === "api-key" ? null : "Test subscription",
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: fixture.authRoute === "api-key" ? "api" : "subscription"
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  })

export const e2eDiscoveredModel = (
  providerId: ProviderId = PROVIDER_ID
): DiscoveredProviderModel => ({
  providerId,
  id: Schema.decodeUnknownSync(ProviderModelId)(`${providerId}/eval-model`),
  label: "Deterministic pi model",
  capabilities: { contextWindow: 32_000, reasoning: [], vision: false }
})

export const e2eCertification = (
  fixture: E2ePiFixture,
  providerId: ProviderId = PROVIDER_ID,
  modelId: ProviderModelId = MODEL_ID
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
  results: [{
    scenarioId: fixture.scenarioId,
    status: "passed",
    failures: [],
    durationMs: 1,
    tokens: 0,
    costUsd: 0
  }],
  certifiedAt: "2026-08-10T00:00:00.000Z"
})

const responsesFor = (fixture: E2ePiFixture): ReadonlyArray<FauxResponseStep> => {
  switch (fixture.scenarioId) {
    case "managed-resources":
      return [
        fauxAssistantMessage(fauxToolCall("resource__managed-skill", {}), {
          stopReason: "toolUse"
        }),
        fauxAssistantMessage("Managed skill loaded through pi.")
      ]
    default:
      return [fauxAssistantMessage("Completed through deterministic pi.")]
  }
}

export const configureE2ePiProvider = (fixture: E2ePiFixture) => {
  const provider = fauxProvider({
    provider: PROVIDER_ID,
    api: "jingler-e2e-api",
    models: [{ id: "eval-model" }],
    tokensPerSecond: 0
  })
  provider.setResponses([...responsesFor(fixture)])
  return (runtime: ModelRuntime): void => {
    runtime.registerNativeProvider(provider.provider)
  }
}

export const E2E_PI_CONNECTION_ID = CONNECTION_ID
export const E2E_PI_MODEL_ID = MODEL_ID
