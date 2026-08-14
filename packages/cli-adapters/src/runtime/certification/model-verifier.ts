import {
  expectedBillingRouteForAuthKind,
  CURRENT_RUNTIME_CONTRACTS,
  type EvalResult,
  type ModelCertification,
  type ProviderConnection,
  type ProviderModelId
} from "@jingler/core"
import { Data, Duration, Effect } from "effect"
import type { AuthBrokerOptions, EntitlementProbeResult } from "../auth/auth-broker.js"
import type { ProviderCredentialStore } from "../auth/credential-store.js"
import { probePiEntitlement } from "../providers/pi-provider-access.js"
import type { EvalTrace } from "./behavior-contract.js"
import { scoreScenario } from "./pi-eval.js"
import {
  CORE_CAPABILITY_PROFILE,
  CORE_PI_SCENARIOS,
  scenarioById
} from "./pi-scenarios.js"
import {
  runPiScenario,
  type RunPiScenarioInput
} from "./pi-scenario-runner.js"

export class ModelVerificationError extends Data.TaggedError(
  "ModelVerificationError"
)<{ readonly message: string; readonly cause?: unknown }> {}

type ScenarioRunner = (input: RunPiScenarioInput) => Promise<EvalTrace>

export interface VerifyProviderModelBehaviorInput {
  readonly connection: ProviderConnection
  readonly access: string
  readonly credentials: ProviderCredentialStore
  readonly modelId: ProviderModelId
  readonly provenance?: ModelCertification["provenance"]
  readonly probe?: AuthBrokerOptions["probe"]
  readonly runScenario?: ScenarioRunner
  readonly entitlementTimeoutMs?: number
  readonly now?: () => Date
}

export interface ModelVerificationResult {
  readonly certification: ModelCertification
  readonly traces: ReadonlyArray<EvalTrace>
}

const observeRoute = (
  input: VerifyProviderModelBehaviorInput
): Effect.Effect<EntitlementProbeResult, ModelVerificationError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.tryPromise({
        try: () => (input.probe ?? probePiEntitlement)({
          providerId: input.connection.providerId,
          authKind: input.connection.authKind,
          access: input.access,
          signal: controller.signal
        }),
        catch: (cause) => new ModelVerificationError({
          message: `${input.connection.id} entitlement probe failed`,
          cause
        })
      }),
    (controller) => Effect.sync(() => controller.abort())
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(input.entitlementTimeoutMs ?? 60_000),
      onTimeout: () =>
        new ModelVerificationError({
          message: `${input.connection.id} entitlement probe timed out`
        })
    })
  )

const requireObservedRoute = (
  connection: ProviderConnection,
  observation: EntitlementProbeResult
): Effect.Effect<void, ModelVerificationError> => {
  const expected = expectedBillingRouteForAuthKind(connection.authKind)
  if (
    observation.entitlement !== "active" ||
    observation.billingRoute !== expected
  ) {
    return Effect.fail(new ModelVerificationError({
      message: `${connection.id} did not confirm its ${expected} billing route`
    }))
  }
  if (observation.observedRoute.trim().length === 0) {
    return Effect.fail(new ModelVerificationError({
      message: `${connection.id} returned no observable provider route`
    }))
  }
  return Effect.void
}

const resolveProviderModelId = (
  connection: ProviderConnection,
  modelId: ProviderModelId
): Effect.Effect<string, ModelVerificationError> => {
  const qualified = String(modelId)
  const prefix = `${connection.providerId}/`
  const providerModelId = qualified.startsWith(prefix)
    ? qualified.slice(prefix.length)
    : ""
  return providerModelId.length > 0
    ? Effect.succeed(providerModelId)
    : Effect.fail(new ModelVerificationError({
        message: `Model ${qualified} does not belong to provider ${connection.providerId}`
      }))
}

const verifiedConnection = (
  connection: ProviderConnection,
  observation: EntitlementProbeResult,
  verifiedAt: Date
): ProviderConnection => ({
  ...connection,
  account: connection.account === null
    ? null
    : { ...connection.account, displayLabel: observation.planLabel },
  status: "authenticated",
  subscription: {
    ...connection.subscription,
    entitlement: observation.entitlement,
    planLabel: observation.planLabel,
    quotaLabel: observation.quotaLabel,
    rateLimitLabel: observation.rateLimitLabel,
    confirmedBillingRoute: observation.billingRoute
  },
  updatedAt: verifiedAt.toISOString()
})

const failedTrace = (scenarioId: string, startedAt: number): EvalTrace => ({
  scenarioId,
  observations: [
    { kind: "report-text", text: "Provider scenario failed" },
    { kind: "event", tag: "Failed" }
  ],
  durationMs: Math.max(1, Math.ceil(performance.now() - startedAt)),
  tokens: 0,
  costUsd: 0,
  versions: CURRENT_RUNTIME_CONTRACTS
})

const scoreTraces = (
  traces: ReadonlyArray<EvalTrace>
): ReadonlyArray<EvalResult> =>
  traces.map((trace) => {
    const scenario = scenarioById(trace.scenarioId)
    return scenario === null
      ? {
          scenarioId: trace.scenarioId,
          status: "failed",
          failures: ["unknown behavior scenario"],
          durationMs: trace.durationMs,
          tokens: trace.tokens,
          costUsd: trace.costUsd
        }
      : scoreScenario(scenario, trace)
  })

export const evaluateProviderModelBehavior = (
  input: VerifyProviderModelBehaviorInput
): Effect.Effect<ModelVerificationResult, ModelVerificationError> =>
  Effect.gen(function* () {
    const providerModelId = yield* resolveProviderModelId(
      input.connection,
      input.modelId
    )
    const observation = yield* observeRoute(input)
    yield* requireObservedRoute(input.connection, observation)
    const verifiedAt = input.now?.() ?? new Date()
    const connection = verifiedConnection(input.connection, observation, verifiedAt)
    const target = {
      providerId: connection.providerId,
      modelId: providerModelId,
      capabilities: {
        versions: CURRENT_RUNTIME_CONTRACTS,
        toolIds: [],
        resourceIds: [],
        targetId: connection.targetId
      }
    }
    const execute = input.runScenario ?? runPiScenario
    const traces = yield* Effect.forEach(
      CORE_PI_SCENARIOS,
      (scenario) => {
        const startedAt = performance.now()
        return Effect.tryPromise(() => execute({
          scenarioId: scenario.id,
          connection,
          credentials: input.credentials,
          target
        })).pipe(
          Effect.catchAll(() => Effect.succeed(failedTrace(scenario.id, startedAt)))
        )
      },
      { concurrency: 1 }
    )
    const results = scoreTraces(traces)
    const corePassed = results.every((result) => result.status === "passed")
    return {
      traces,
      certification: {
        providerId: input.connection.providerId,
        modelId: input.modelId,
        authRoute: {
          kind: input.connection.authKind,
          observedRoute: observation.observedRoute,
          subscription: expectedBillingRouteForAuthKind(input.connection.authKind) === "subscription",
          entitlementConfirmed: observation.entitlement === "active",
          apiBillingFallbackObserved:
            expectedBillingRouteForAuthKind(input.connection.authKind) === "subscription" &&
            observation.billingRoute === "api"
        },
        versions: CURRENT_RUNTIME_CONTRACTS,
        provenance: input.provenance ?? "local",
        capabilityProfiles: corePassed ? [CORE_CAPABILITY_PROFILE.id] : [],
        results,
        certifiedAt: verifiedAt.toISOString()
      },
    }
  })

export const verifyProviderModelBehavior = (
  input: VerifyProviderModelBehaviorInput
): Effect.Effect<ModelCertification, ModelVerificationError> =>
  evaluateProviderModelBehavior(input).pipe(
    Effect.map((result) => result.certification)
  )
