import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderModelId,
  type AuthKind,
  type EvalResult,
  type ModelCertification,
  type ProviderConnection as ProviderConnectionType
} from "@jingler/core"
import { Data, Effect, Schema } from "effect"
import { InMemoryProviderCredentialStore } from "../../src/runtime/auth/credential-store.js"
import type {
  AuthBrokerOptions,
  EntitlementProbeResult
} from "../../src/runtime/auth/auth-broker.js"
import { probePiEntitlement } from "../../src/runtime/providers/pi-provider-access.js"
import type { EvalTrace } from "../behavior-contract.js"
import { runPiScenario } from "../deterministic-runtime.js"
import { scoreScenario } from "../pi-eval.js"
import {
  CORE_CAPABILITY_PROFILE,
  CORE_PI_SCENARIOS,
  scenarioById
} from "../pi-scenarios.js"

export const LiveEvalTarget = Schema.Struct({
  connection: ProviderConnection,
  modelId: ProviderModelId,
  accessCredentialEnv: Schema.String,
  refreshCredentialEnv: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number)
})
export type LiveEvalTarget = Schema.Schema.Type<typeof LiveEvalTarget>

export const LiveEvalMatrix = Schema.Array(LiveEvalTarget)
export type LiveEvalMatrix = Schema.Schema.Type<typeof LiveEvalMatrix>

export class LiveEvalError extends Data.TaggedError("LiveEvalError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LiveTargetResult {
  readonly certification: ModelCertification
  readonly traces: ReadonlyArray<EvalTrace>
}

const expectedBillingRoute = (
  authKind: AuthKind
): ProviderConnectionType["subscription"]["confirmedBillingRoute"] => {
  switch (authKind) {
    case "claude-setup-token":
    case "openai-codex-oauth":
      return "subscription"
    case "api-key":
      return "api"
    case "device-environment":
      return "device-environment"
  }
}

const requireObservedRoute = (
  connection: ProviderConnectionType,
  observation: EntitlementProbeResult
): Effect.Effect<void, LiveEvalError> => {
  const expected = expectedBillingRoute(connection.authKind)
  if (
    observation.entitlement !== "active" ||
    observation.billingRoute !== expected
  ) {
    return Effect.fail(new LiveEvalError({
      message: `${connection.id} has not confirmed its ${expected} billing route`
    }))
  }
  if (observation.observedRoute.trim().length === 0) {
    return Effect.fail(new LiveEvalError({
      message: `${connection.id} returned no observable provider route`
    }))
  }
  return Effect.void
}

const requiredCredential = (
  name: string
): Effect.Effect<string, LiveEvalError> => {
  const value = process.env[name]
  return value
    ? Effect.succeed(value)
    : Effect.fail(new LiveEvalError({ message: `Credential environment variable ${name} is unavailable` }))
}

const optionalCredential = (
  name: string | null
): Effect.Effect<string | null, LiveEvalError> =>
  name === null ? Effect.succeed(null) : requiredCredential(name)

const makeCredentials = (
  target: LiveEvalTarget
): Effect.Effect<{
  readonly access: string
  readonly store: InMemoryProviderCredentialStore
}, LiveEvalError> =>
  Effect.gen(function* () {
    const access = yield* requiredCredential(target.accessCredentialEnv)
    const oauth = target.connection.authKind === "openai-codex-oauth"
    if (oauth && target.refreshCredentialEnv === null) {
      return yield* new LiveEvalError({
        message: "A Codex OAuth refresh credential environment name is required"
      })
    }
    const refresh = yield* optionalCredential(target.refreshCredentialEnv)
    if (oauth && target.expiresAt === null) {
      return yield* new LiveEvalError({ message: "Codex OAuth expiry is required" })
    }
    const store = new InMemoryProviderCredentialStore()
    yield* store.write({
      connectionId: target.connection.id,
      authKind: target.connection.authKind,
      access,
      refresh,
      expiresAt: target.expiresAt
    }).pipe(
      Effect.mapError((cause) => new LiveEvalError({
        message: "Failed to stage the connection-pinned credential",
        cause
      }))
    )
    return { access, store }
  })

const observeRoute = (
  target: LiveEvalTarget,
  access: string,
  probe: AuthBrokerOptions["probe"]
): Effect.Effect<EntitlementProbeResult, LiveEvalError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.tryPromise({
        try: () => probe({
          providerId: target.connection.providerId,
          authKind: target.connection.authKind,
          access,
          signal: controller.signal
        }),
        catch: (cause) => new LiveEvalError({
          message: `${target.connection.id} entitlement probe failed`,
          cause
        })
      }).pipe(
        Effect.tap((observation) =>
          requireObservedRoute(target.connection, observation)
        )
      ),
    (controller) => Effect.sync(() => controller.abort())
  )

const targetFromObservation = (
  target: LiveEvalTarget,
  observation: EntitlementProbeResult
): LiveEvalTarget => ({
  ...target,
  connection: {
    ...target.connection,
    account:
      target.connection.account === null
        ? null
        : {
            ...target.connection.account,
            displayLabel: observation.planLabel
          },
    status: "authenticated",
    subscription: {
      entitlement: observation.entitlement,
      planLabel: observation.planLabel,
      expiresAt:
        target.expiresAt === null
          ? null
          : new Date(target.expiresAt).toISOString(),
      quotaLabel: observation.quotaLabel,
      rateLimitLabel: observation.rateLimitLabel,
      confirmedBillingRoute: observation.billingRoute
    },
    updatedAt: new Date().toISOString()
  }
})

const failedTrace = (scenarioId: string, durationMs: number): EvalTrace => ({
  scenarioId,
  observations: [
    { kind: "report-text", text: "Live provider scenario failed" },
    { kind: "event", tag: "Failed" }
  ],
  durationMs,
  tokens: 0,
  costUsd: 0,
  versions: CURRENT_RUNTIME_CONTRACTS
})

const runScenario = (
  target: LiveEvalTarget,
  credentials: InMemoryProviderCredentialStore,
  scenarioId: string
): Effect.Effect<EvalTrace> => {
  const startedAt = performance.now()
  const qualified = String(target.modelId)
  const prefix = `${target.connection.providerId}/`
  const modelId = qualified.startsWith(prefix)
    ? qualified.slice(prefix.length)
    : qualified
  return Effect.tryPromise(() => runPiScenario({
    scenarioId,
    connection: target.connection,
    credentials,
    target: { providerId: target.connection.providerId, modelId }
  })).pipe(
    Effect.catchAll(() => Effect.succeed(failedTrace(
      scenarioId,
      Math.max(1, Math.ceil(performance.now() - startedAt))
    )))
  )
}

const scoreTraces = (traces: ReadonlyArray<EvalTrace>): ReadonlyArray<EvalResult> =>
  traces.map((trace) => {
    const scenario = scenarioById(trace.scenarioId)
    if (scenario === null) {
      return {
        scenarioId: trace.scenarioId,
        status: "failed",
        failures: ["unknown live scenario"],
        durationMs: trace.durationMs,
        tokens: trace.tokens,
        costUsd: trace.costUsd
      }
    }
    return scoreScenario(scenario, trace)
  })

export const runLiveTarget = (
  target: LiveEvalTarget,
  provenance: ModelCertification["provenance"],
  options: {
    readonly probe?: AuthBrokerOptions["probe"]
    readonly runScenario?: (
      target: LiveEvalTarget,
      credentials: InMemoryProviderCredentialStore,
      scenarioId: string
    ) => Effect.Effect<EvalTrace>
  } = {}
): Effect.Effect<LiveTargetResult, LiveEvalError> =>
  Effect.gen(function* () {
    const credentials = yield* makeCredentials(target)
    const observation = yield* observeRoute(
      target,
      credentials.access,
      options.probe ?? probePiEntitlement
    )
    const verifiedTarget = targetFromObservation(target, observation)
    const traces = yield* Effect.forEach(
      CORE_PI_SCENARIOS,
      (scenario) =>
        (options.runScenario ?? runScenario)(
          verifiedTarget,
          credentials.store,
          scenario.id
        ),
      { concurrency: 1 }
    )
    return {
      traces,
      certification: {
        providerId: target.connection.providerId,
        modelId: target.modelId,
        authRoute: {
          kind: target.connection.authKind,
          observedRoute: observation.observedRoute,
          subscription: expectedBillingRoute(target.connection.authKind) === "subscription",
          entitlementConfirmed: observation.entitlement === "active",
          apiBillingFallbackObserved:
            expectedBillingRoute(target.connection.authKind) === "subscription" &&
            observation.billingRoute === "api"
        },
        versions: CURRENT_RUNTIME_CONTRACTS,
        provenance,
        capabilityProfiles: [CORE_CAPABILITY_PROFILE.id],
        results: scoreTraces(traces),
        certifiedAt: new Date().toISOString()
      }
    }
  })

export const runLiveMatrix = (
  targets: LiveEvalMatrix,
  provenance: ModelCertification["provenance"]
): Effect.Effect<ReadonlyArray<LiveTargetResult>, LiveEvalError> =>
  Effect.forEach(targets, (target) => runLiveTarget(target, provenance), {
    concurrency: 1
  })
