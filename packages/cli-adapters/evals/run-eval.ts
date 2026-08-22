import { readFile, writeFile } from "node:fs/promises"
import {
  CURRENT_RUNTIME_CONTRACTS,
  ModelCertification,
  ReleaseModelCandidate,
  type EvalResult
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { EvalTrace } from "./behavior-contract.js"
import {
  LiveEvalMatrix,
  requireReleaseCandidateMatrix,
  runLiveMatrix
} from "./live/live-matrix.js"
import { redactErrorMessage, redactReport, scoreScenario } from "./pi-eval.js"
import { CORE_PI_SCENARIOS, HARNESS_PI_SCENARIOS, SELECTION_PI_SCENARIOS, scenarioById } from "./pi-scenarios.js"
import {
  runDeterministicHarnessScenario,
  runDeterministicScenario
} from "./deterministic-runtime.js"
import { AtomicJsonFile } from "../src/runtime/persistence/atomic-json-file.js"

const deterministicTraces = (): Promise<ReadonlyArray<EvalTrace>> =>
  Effect.runPromise(
    Effect.forEach(
      [
        ...CORE_PI_SCENARIOS.map((scenario) => ({
          id: scenario.id,
          run: runDeterministicScenario
        })),
        ...SELECTION_PI_SCENARIOS.map((scenario) => ({
          id: scenario.id,
          run: runDeterministicScenario
        })),
        ...HARNESS_PI_SCENARIOS.map((scenario) => ({
          id: scenario.id,
          run: runDeterministicHarnessScenario
        }))
      ],
      (scenario) => Effect.promise(() => scenario.run(scenario.id)),
      { concurrency: 1 }
    )
  )

const secretValues = (): ReadonlyArray<string> =>
  (process.env.JINGLER_EVAL_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => process.env[name.trim()] ?? "")
    .filter(Boolean)

const markdown = (mode: string, results: ReadonlyArray<EvalResult>): string => [
  `# Jingler pi ${mode} evaluation`,
  "",
  "| Scenario | Status | Score | Duration |",
  "| --- | --- | ---: | ---: |",
  ...results.map((result) =>
    `| ${result.scenarioId} | ${result.status} | ${
      result.score === undefined ? "—" : result.score.toFixed(2)
    } | ${result.durationMs}ms |`
  ),
  ""
].join("\n")

const mode = process.argv[2] ?? "deterministic"
if (mode !== "deterministic" && mode !== "live" && mode !== "replay") {
  throw new Error(`unsupported eval mode: ${mode}`)
}

let certifications: ReadonlyArray<ModelCertification> = []
let liveCredentialValues: ReadonlyArray<string> = []
const traces = mode === "deterministic"
  ? await deterministicTraces()
  : mode === "replay"
    ? await (async () => {
        const path = process.env.JINGLER_REPLAY_TRACE
        if (!path) throw new Error("replay eval requires a sanitized trace path")
        return Schema.decodeUnknownSync(Schema.Array(EvalTrace))(
          JSON.parse(await readFile(path, "utf8"))
        )
      })()
    : await (async () => {
        if (process.env.JINGLER_EVAL !== "1") {
          throw new Error("live eval requires JINGLER_EVAL=1")
        }
        const path = process.env.JINGLER_LIVE_EVAL_MATRIX
        if (!path) throw new Error("live eval requires JINGLER_LIVE_EVAL_MATRIX")
        const targets = Schema.decodeUnknownSync(LiveEvalMatrix)(
          JSON.parse(await readFile(path, "utf8"))
        )
        if (targets.length === 0) throw new Error("live eval matrix is empty")
        if (process.env.JINGLER_EVAL_REVIEWED === "1") {
          const candidatesPath = process.env.JINGLER_RELEASE_CANDIDATES
          if (!candidatesPath) {
            throw new Error("reviewed live eval requires JINGLER_RELEASE_CANDIDATES")
          }
          const candidates = Schema.decodeUnknownSync(Schema.Array(ReleaseModelCandidate))(
            JSON.parse(await readFile(candidatesPath, "utf8"))
          )
          await Effect.runPromise(requireReleaseCandidateMatrix(targets, candidates))
        }
        liveCredentialValues = targets.flatMap((target) => [
          process.env[target.accessCredentialEnv] ?? "",
          target.refreshCredentialEnv === null
            ? ""
            : (process.env[target.refreshCredentialEnv] ?? "")
        ]).filter(Boolean)
        const provenance = process.env.JINGLER_EVAL_REVIEWED === "1"
          ? "reviewed-release" as const
          : "local" as const
        const samplesEnv = process.env.JINGLER_EVAL_PLAN_SAMPLES
        const liveHarness = samplesEnv === undefined
          ? {}
          : { samples: Schema.decodeUnknownSync(Schema.NumberFromString)(samplesEnv) }
        const live = await Effect.runPromise(
          runLiveMatrix(targets, provenance, { liveHarness })
        ).catch((cause) => {
          const failure = cause instanceof Error ? cause : new Error("Live evaluation failed")
          throw new Error(
            redactErrorMessage(failure, [...secretValues(), ...liveCredentialValues])
          )
        })
        certifications = live.map((result) => result.certification)
        return live.flatMap((result) => result.traces)
      })()

/**
 * Live results come from the certification aggregates: the harness scenarios
 * are pass@k, so scoring their raw sample traces here would fail the whole
 * run on one flaky sample the majority already absorbed. Deterministic and
 * replay traces are single-shot and score directly.
 */
const results = mode === "live"
  ? certifications.flatMap((certification) => certification.results)
  : traces.map((trace) => {
      const scenario = scenarioById(trace.scenarioId)
      if (scenario === null) throw new Error(`unknown scenario: ${trace.scenarioId}`)
      return scoreScenario(scenario, trace)
    })
const maxCostUsd = process.env.JINGLER_EVAL_MAX_COST_USD
  ? Schema.decodeUnknownSync(Schema.NumberFromString)(process.env.JINGLER_EVAL_MAX_COST_USD)
  : null
const totalCostUsd = results.reduce((total, result) => total + result.costUsd, 0)
if (maxCostUsd !== null && totalCostUsd > maxCostUsd) {
  throw new Error(`live eval cost ${totalCostUsd} exceeded ceiling ${maxCostUsd}`)
}
if (mode === "live") {
  const certificationsPath = process.env.JINGLER_LIVE_CERTIFICATIONS
  if (!certificationsPath) {
    throw new Error("live eval requires JINGLER_LIVE_CERTIFICATIONS")
  }
  const document = Schema.Array(ModelCertification)
  await new AtomicJsonFile({
    file: certificationsPath,
    decode: (raw) => Schema.decodeUnknownSync(Schema.parseJson(document))(raw),
    fallback: () => []
  }).write(certifications)
}
const report = redactReport(JSON.stringify({
  mode,
  versions: CURRENT_RUNTIME_CONTRACTS,
  totalCostUsd,
  routes: certifications.map((certification) => ({
    providerId: certification.providerId,
    modelId: certification.modelId,
    authKind: certification.authRoute.kind,
    observedRoute: certification.authRoute.observedRoute,
    provenance: certification.provenance
  })),
  results
}, null, 2), [...secretValues(), ...liveCredentialValues])
const reportPath = process.env.JINGLER_EVAL_REPORT
if (reportPath) await writeFile(reportPath, report, "utf8")
await new Promise<void>((resolve) => {
  process.stdout.write(`${report}\n${markdown(mode, results)}`, () => resolve())
})
process.exit(results.some((result) => result.status !== "passed") ? 1 : 0)
