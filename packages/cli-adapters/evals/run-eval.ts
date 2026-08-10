import { readFile, writeFile } from "node:fs/promises"
import { CURRENT_RUNTIME_CONTRACTS, type EvalResult } from "@jingler/core"
import { Schema } from "effect"
import { EvalTrace } from "./behavior-contract.js"
import { redactReport, scoreScenario } from "./pi-eval.js"
import { CORE_PI_SCENARIOS, scenarioById } from "./pi-scenarios.js"
import { runDeterministicScenario } from "./deterministic-runtime.js"

const deterministicTraces = (): Promise<ReadonlyArray<EvalTrace>> =>
  Promise.all(CORE_PI_SCENARIOS.map((scenario) => runDeterministicScenario(scenario.id)))

const secretValues = (): ReadonlyArray<string> =>
  (process.env.JINGLER_EVAL_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => process.env[name.trim()] ?? "")
    .filter(Boolean)

const markdown = (mode: string, results: ReadonlyArray<EvalResult>): string => [
  `# Jingler pi ${mode} evaluation`,
  "",
  "| Scenario | Status | Duration |",
  "| --- | --- | ---: |",
  ...results.map((result) => `| ${result.scenarioId} | ${result.status} | ${result.durationMs}ms |`),
  ""
].join("\n")

const mode = process.argv[2] ?? "deterministic"
if (mode !== "deterministic" && mode !== "live" && mode !== "replay") {
  throw new Error(`unsupported eval mode: ${mode}`)
}

const traces = mode === "deterministic"
  ? await deterministicTraces()
  : await (async () => {
      if (mode === "live" && process.env.JINGLER_EVAL !== "1") throw new Error("live eval requires JINGLER_EVAL=1")
      const path = mode === "live" ? process.env.JINGLER_LIVE_EVAL_TRACE : process.env.JINGLER_REPLAY_TRACE
      if (!path) throw new Error(`${mode} eval requires a sanitized trace path`)
      return Schema.decodeUnknownSync(Schema.Array(EvalTrace))(
        JSON.parse(await readFile(path, "utf8"))
      )
    })()

const results = traces.map((trace) => {
  const scenario = scenarioById(trace.scenarioId)
  if (scenario === null) throw new Error(`unknown scenario: ${trace.scenarioId}`)
  return scoreScenario(scenario, trace)
})
const report = redactReport(JSON.stringify({ mode, versions: CURRENT_RUNTIME_CONTRACTS, results }, null, 2), secretValues())
const reportPath = process.env.JINGLER_EVAL_REPORT
if (reportPath) await writeFile(reportPath, report, "utf8")
process.stdout.write(`${report}\n${markdown(mode, results)}`)
if (results.some((result) => result.status !== "passed")) process.exitCode = 1
