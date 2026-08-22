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
  LIVE_HARNESS_PI_SCENARIOS,
  SELECTION_PI_SCENARIOS,
  scenarioById
} from "./pi-scenarios.js"
import {
  runPiScenario,
  type RunPiScenarioInput
} from "./pi-scenario-runner.js"
import { runHarnessScenario } from "./harness-scenario-runner.js"
import { evalSeedPlan, PLAN_EXECUTION_PROMPT } from "./pi-scenario-fixture.js"

export class ModelVerificationError extends Data.TaggedError(
  "ModelVerificationError"
)<{ readonly message: string; readonly cause?: unknown }> {}

type ScenarioRunner = (input: RunPiScenarioInput) => Promise<EvalTrace>

export interface LiveHarnessRunInput {
  readonly scenarioId: string
  readonly connection: ProviderConnection
  readonly credentials: ProviderCredentialStore
  readonly modelId: ProviderModelId
  /** 0-based sample index within the pass@k loop. */
  readonly sample: number
}

/**
 * Opt-in full-harness behavior evals for live runs. Absent → certification is
 * exactly the historical core-scenario pass (deterministic tests and manual
 * flows unchanged). Present → each scenario in `LIVE_HARNESS_PI_SCENARIOS`
 * runs `samples` times against the real model and the certification records
 * one MAJORITY-aggregated result per scenario, because a stochastic model
 * behavior scored single-shot would flake the whole matrix.
 */
export interface LiveHarnessOptions {
  /** pass@k sample count; default 3. */
  readonly samples?: number
  /** Test seam; production leaves this unset and drives the real harness. */
  readonly run?: (input: LiveHarnessRunInput) => Promise<EvalTrace>
}

export interface VerifyProviderModelBehaviorInput {
  readonly connection: ProviderConnection
  readonly access: string
  readonly credentials: ProviderCredentialStore
  readonly modelId: ProviderModelId
  readonly provenance?: ModelCertification["provenance"]
  readonly probe?: AuthBrokerOptions["probe"]
  readonly runScenario?: ScenarioRunner
  readonly liveHarness?: LiveHarnessOptions
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

const defaultLiveHarnessRun = (input: LiveHarnessRunInput): Promise<EvalTrace> =>
  runHarnessScenario({
    scenarioId: input.scenarioId,
    prompt: PLAN_EXECUTION_PROMPT,
    connection: input.connection,
    credentials: input.credentials,
    modelId: String(input.modelId),
    seedPlan: evalSeedPlan()
  })

const sampleScore = (result: EvalResult): number =>
  result.score ?? (result.status === "passed" ? 1 : 0)

/**
 * One certification row per live harness scenario: strict majority passes,
 * per-sample failures kept (prefixed) so a flaky pass still shows its misses,
 * cost/tokens summed so the eval cost ceiling sees every sample.
 */
const aggregateHarnessSamples = (
  scenarioId: string,
  samples: ReadonlyArray<EvalResult>
): EvalResult => {
  const passes = samples.filter((sample) => sample.status === "passed").length
  return {
    scenarioId,
    status: passes * 2 > samples.length ? "passed" : "failed",
    failures: samples.flatMap((sample, index) =>
      sample.failures.map((failure) => `sample ${index + 1}: ${failure}`)
    ),
    score:
      samples.reduce((total, sample) => total + sampleScore(sample), 0) /
      Math.max(1, samples.length),
    durationMs: samples.reduce((total, sample) => total + sample.durationMs, 0),
    tokens: samples.reduce((total, sample) => total + sample.tokens, 0),
    costUsd: samples.reduce((total, sample) => total + sample.costUsd, 0)
  }
}

const runLiveHarnessScenarios = (
  input: VerifyProviderModelBehaviorInput,
  connection: ProviderConnection,
  target: RunPiScenarioInput["target"],
  harness: LiveHarnessOptions
): Effect.Effect<{
  readonly traces: ReadonlyArray<EvalTrace>
  readonly results: ReadonlyArray<EvalResult>
}> =>
  Effect.gen(function* () {
    const samples = harness.samples ?? 3
    const runHarness = harness.run ?? defaultLiveHarnessRun
    const runRuntime = input.runScenario ?? runPiScenario
    // Harness scenarios go through AgentRunner (plan persistence lives there);
    // selection scenarios go through the runtime scenario runner (their fake
    // MCP mounts live there). Both sample pass@k under one aggregation.
    const jobs = [
      ...LIVE_HARNESS_PI_SCENARIOS.map((scenario) => ({
        scenario,
        run: (sample: number) =>
          runHarness({
            scenarioId: scenario.id,
            connection,
            credentials: input.credentials,
            modelId: input.modelId,
            sample
          })
      })),
      ...SELECTION_PI_SCENARIOS.map((scenario) => ({
        scenario,
        run: (_sample: number) =>
          runRuntime({
            scenarioId: scenario.id,
            connection,
            credentials: input.credentials,
            target
          })
      }))
    ]
    const traces: Array<EvalTrace> = []
    const results: Array<EvalResult> = []
    for (const job of jobs) {
      const sampleResults: Array<EvalResult> = []
      for (let sample = 0; sample < samples; sample += 1) {
        const startedAt = performance.now()
        const trace = yield* Effect.tryPromise(() => job.run(sample)).pipe(
          Effect.catchAll(() => Effect.succeed(failedTrace(job.scenario.id, startedAt)))
        )
        traces.push(trace)
        sampleResults.push(scoreScenario(job.scenario, trace))
      }
      results.push(aggregateHarnessSamples(job.scenario.id, sampleResults))
    }
    return { traces, results }
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

const runCoreScenarios = (
  input: VerifyProviderModelBehaviorInput,
  connection: ProviderConnection,
  target: RunPiScenarioInput["target"]
): Effect.Effect<ReadonlyArray<EvalTrace>> => {
  const execute = input.runScenario ?? runPiScenario
  return Effect.forEach(
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
}

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
    const traces = yield* runCoreScenarios(input, connection, target)
    const coreResults = scoreTraces(traces)
    const harness = input.liveHarness === undefined
      ? { traces: [] as ReadonlyArray<EvalTrace>, results: [] as ReadonlyArray<EvalResult> }
      : yield* runLiveHarnessScenarios(input, connection, target, input.liveHarness)
    const results = [...coreResults, ...harness.results]
    // Certification stays a core-contract statement: live harness behavior is
    // reported (and gates the eval run) without revoking a model's core pass.
    const corePassed = coreResults.every((result) => result.status === "passed")
    return {
      traces: [...traces, ...harness.traces],
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
