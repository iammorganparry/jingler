import { readFile, writeFile } from "node:fs/promises"
import { CURRENT_RUNTIME_CONTRACTS, type EvalResult } from "@jingler/core"
import type { EvalObservation, EvalTrace } from "./behavior-contract.js"
import { redactReport, scoreScenario } from "./pi-eval.js"
import { CORE_PI_SCENARIOS, scenarioById } from "./pi-scenarios.js"

const observationsByScenario: Readonly<Record<string, ReadonlyArray<EvalObservation>>> = {
  "lifecycle.complete": [
    { kind: "event", tag: "Started" },
    { kind: "event", tag: "Done" }
  ],
  "permission.denied-edit": [
    { kind: "permission", tool: "workspace.edit", decision: "deny" },
    { kind: "event", tag: "Done" }
  ],
  "auth.codex-subscription-pinned": [
    { kind: "auth-route", route: "openai-codex-oauth" },
    { kind: "event", tag: "Done" }
  ],
  "auth.claude-subscription-pinned": [
    { kind: "auth-route", route: "claude-setup-token" },
    { kind: "event", tag: "Done" }
  ],
  "diff.create-edit-delete-rename": [
    { kind: "file-change", status: "A", path: "src/new.ts", oldPath: null },
    { kind: "file-change", status: "M", path: "src/edit.ts", oldPath: null },
    { kind: "file-change", status: "D", path: "src/delete.ts", oldPath: null },
    { kind: "file-change", status: "R", path: "src/renamed.ts", oldPath: "src/old.ts" },
    { kind: "event", tag: "Done" }
  ],
  "resource.cleanup": [
    { kind: "resource", name: "managed-mcp", state: "opened" },
    { kind: "resource", name: "managed-mcp", state: "closed" },
    { kind: "event", tag: "Done" }
  ],
  "structured.question-plan": [
    { kind: "event", tag: "QuestionRequested" },
    { kind: "event", tag: "PlanProposed" },
    { kind: "event", tag: "Done" }
  ],
  "remote.contract-compatible": [
    { kind: "event", tag: "RemoteContractAccepted" },
    { kind: "event", tag: "Done" }
  ]
}

const deterministicTraces = (): ReadonlyArray<EvalTrace> =>
  CORE_PI_SCENARIOS.map((scenario) => ({
    scenarioId: scenario.id,
    observations: observationsByScenario[scenario.id] ?? [],
    durationMs: 1,
    tokens: 0,
    costUsd: 0,
    versions: CURRENT_RUNTIME_CONTRACTS
  }))

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
  ? deterministicTraces()
  : await (async () => {
      if (mode === "live" && process.env.JINGLER_EVAL !== "1") throw new Error("live eval requires JINGLER_EVAL=1")
      const path = mode === "live" ? process.env.JINGLER_LIVE_EVAL_TRACE : process.env.JINGLER_REPLAY_TRACE
      if (!path) throw new Error(`${mode} eval requires a sanitized trace path`)
      return JSON.parse(await readFile(path, "utf8")) as ReadonlyArray<EvalTrace>
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
