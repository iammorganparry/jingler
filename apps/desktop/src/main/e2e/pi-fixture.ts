import { readFileSync } from "node:fs"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context as PiContext,
  type FauxResponseStep
} from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  AuthKind,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderId,
  ProviderModelId,
  ReasoningEffort,
  type PlanPrd,
  type ModelCertification
} from "@jingler/core"
import { Schema } from "effect"
import {
  planTaskProgressFingerprint,
  scriptedPlanPrd,
  type DiscoveredProviderModel
} from "@jingler/cli-adapters"

const E2ePiFixture = Schema.Struct({
  scenarioId: Schema.String,
  authRoute: AuthKind,
  reasoning: Schema.optional(Schema.Array(ReasoningEffort)),
  seedConnection: Schema.optionalWith(Schema.Boolean, { default: () => true })
})

export type E2ePiFixture = Schema.Schema.Type<typeof E2ePiFixture>

const PROVIDER_ID = Schema.decodeUnknownSync(ProviderId)("jingler-e2e")
const MODEL_ID = Schema.decodeUnknownSync(ProviderModelId)("jingler-e2e/eval-model")
const CONNECTION_ID = "jingler-e2e-connection"
const SUBMIT_PLAN_TOOL = "jingler_submit_plan"

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
  fixture: E2ePiFixture,
  providerId: ProviderId = PROVIDER_ID
): DiscoveredProviderModel => ({
  providerId,
  id: Schema.decodeUnknownSync(ProviderModelId)(`${providerId}/eval-model`),
  label: "Deterministic pi model",
  capabilities: {
    contextWindow: 32_000,
    reasoning: fixture.reasoning ?? [],
    vision: false
  }
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

const latestOperatorText = (context: PiContext): string => {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]
    if (message?.role !== "user") continue
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
  }
  return ""
}

const planTaskMarkers = (plan: PlanPrd): ReadonlyArray<string> =>
  plan.stages.flatMap((stage) =>
    (stage.tasks ?? []).map(
      (task) =>
        `PLAN_TASK stage=${stage.id} fingerprint=${planTaskProgressFingerprint(stage)} task=${task.id} status=completed`
    )
  )

const planResultMarkers = (plan: PlanPrd): ReadonlyArray<string> =>
  plan.stages.flatMap((stage) =>
    stage.acceptance.map(
      (criterion) =>
        `PLAN_RESULT criterion=${criterion.id} status=passed evidence=Deterministic pi completed and verified the planned work.`
    )
  )

const planModeResponse: FauxResponseStep = (context) => {
  const prompt = latestOperatorText(context)
  const amended = prompt.includes("[[amendment]]")
  const plan = scriptedPlanPrd("e2e", amended ? 2 : 1, false, amended)
  const lastMessage = context.messages.at(-1)

  if (lastMessage?.role !== "toolResult" || lastMessage.toolName !== SUBMIT_PLAN_TOOL) {
    return fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL, { plan }), {
      stopReason: "toolUse"
    })
  }
  if (amended) return fauxAssistantMessage("Plan amendment recorded through pi.")

  const markers = prompt.includes("[[plan-partial-hold]]")
    ? planTaskMarkers(plan).filter((marker) => marker.includes("stage=s_02 "))
    : [
        "Steps 2, 3 and 5 are done.",
        ...planTaskMarkers(plan),
        ...(prompt.includes("[[plan-needs-verification]]") ? [] : planResultMarkers(plan))
      ]
  return fauxAssistantMessage(markers.join("\n"))
}

const responsesFor = (fixture: E2ePiFixture): ReadonlyArray<FauxResponseStep> => {
  switch (fixture.scenarioId) {
    case "plan-mode":
      return Array.from({ length: 12 }, () => planModeResponse)
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
    tokensPerSecond: 0,
    ...(fixture.scenarioId === "plan-mode"
      ? { tokenSize: { min: 4_096, max: 4_096 } }
      : {})
  })
  provider.setResponses([...responsesFor(fixture)])
  return (runtime: ModelRuntime): void => {
    runtime.registerNativeProvider(provider.provider)
  }
}

export const E2E_PI_CONNECTION_ID = CONNECTION_ID
export const E2E_PI_MODEL_ID = MODEL_ID
