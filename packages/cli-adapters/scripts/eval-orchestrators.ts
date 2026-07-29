#!/usr/bin/env node
/**
 * Live provider/model procedure eval.
 *
 * This intentionally drives the real installed harnesses; deterministic unit
 * tests grade the rubric itself. Run the cheap smoke matrix:
 *
 *   pnpm --filter @jingler/cli-adapters eval:orchestrators
 *
 * Or cover every model from a captured live catalogue:
 *
 *   JINGLER_ORCHESTRATOR_EVAL_ROUTES='claude/opus,claude/haiku,codex/gpt-5.6-sol' \
 *     pnpm --filter @jingler/cli-adapters eval:orchestrators
 *
 * A missing harness, invalid plan, post-approval planner tool, lost amendment,
 * unavailable worker route, or planner-authored progress exits non-zero.
 */
import { execFileSync } from "node:child_process"
import type { CliKind, Plan, StreamEvent } from "@jingler/core"
import { DEFAULT_PLAN_TEMPLATE_HTML } from "@jingler/core"
import { Effect } from "effect"
import {
  CliAdapter,
  PlanDecision,
  type AgentContext,
  type OrchestrationRoute,
  type SessionSpec
} from "../src/adapter.js"
import { HarnessCliAdapterLive } from "../src/harness-adapter.js"
import {
  evaluateOrchestratorProcedure,
  ORCHESTRATOR_EVAL_SMOKE_ROUTES,
  type OrchestratorEvalReport,
  type OrchestratorEvalRoute
} from "../src/orchestrator-eval.js"
import { planNote } from "../src/plan-prompt.js"

const executableName: Readonly<Record<CliKind, string>> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  opencode: "opencode"
}

const parseRoute = (value: string): OrchestratorEvalRoute | null => {
  const separator = value.indexOf("/")
  if (separator < 1 || separator === value.length - 1) return null
  const cli = value.slice(0, separator)
  if (cli !== "claude" && cli !== "codex" && cli !== "opencode") return null
  return { cli, model: value.slice(separator + 1) }
}

const configuredRoutes = (): ReadonlyArray<OrchestratorEvalRoute> => {
  const raw = process.env.JINGLER_ORCHESTRATOR_EVAL_ROUTES
  if (raw === undefined || raw.trim().length === 0) {
    return ORCHESTRATOR_EVAL_SMOKE_ROUTES
  }
  const routes = raw
    .split(",")
    .map((candidate) => parseRoute(candidate.trim()))
    .filter((route): route is OrchestratorEvalRoute => route !== null)
  if (routes.length === 0) {
    throw new Error(
      "JINGLER_ORCHESTRATOR_EVAL_ROUTES must contain comma-separated cli/model routes."
    )
  }
  return routes
}

const findExecutable = (cli: CliKind): string | null => {
  const envName = `JINGLER_ORCHESTRATOR_${cli.toUpperCase()}_BIN`
  const configured = process.env[envName]
  if (configured !== undefined && configured.length > 0) return configured
  try {
    return execFileSync("/usr/bin/which", [executableName[cli]], {
      encoding: "utf8"
    }).trim()
  } catch {
    return null
  }
}

const routeCatalogue = (
  routes: ReadonlyArray<OrchestratorEvalRoute>
): ReadonlyArray<OrchestrationRoute> => {
  const byCli = new Map<CliKind, Array<{ id: string; label: string }>>()
  for (const route of routes) {
    const models = byCli.get(route.cli) ?? []
    if (!models.some((model) => model.id === route.model)) {
      models.push({ id: route.model, label: route.model })
    }
    byCli.set(route.cli, models)
  }
  return [...byCli].map(([cli, models]) => ({ cli, models }))
}

interface LiveTurn {
  readonly source: string | null
  readonly delegated: boolean
  readonly eventsAfterDelegation: ReadonlyArray<StreamEvent>
}

const evalPrompt = (
  route: OrchestratorEvalRoute,
  catalogue: ReadonlyArray<OrchestrationRoute>,
  amendment?: { readonly source: string; readonly request: string }
): string => {
  const task =
    amendment === undefined
      ? [
          "Create a canonical implementation plan for an audit-log feature.",
          "It must contain a storage stage, an API stage that depends on storage,",
          "and an independent documentation stage so parallel assignment is observable."
        ].join(" ")
      : [
          "Amend the canonical plan below. Preserve every existing stage and acceptance id.",
          `Add this requirement exactly: ${amendment.request}`,
          "",
          amendment.source
        ].join("\n")
  const replyProtocol = planNote(route.cli, DEFAULT_PLAN_TEMPLATE_HTML, catalogue)
  return [
    "You are this session's orchestrator and canonical planner.",
    "Inspect read-only, propose the plan, then stop. Jingler—not this planner—executes approval.",
    task,
    ...(replyProtocol === null ? [] : ["", replyProtocol])
  ].join("\n")
}

const runLiveTurn = async (
  route: OrchestratorEvalRoute,
  binPath: string,
  catalogue: ReadonlyArray<OrchestrationRoute>,
  amendment?: { readonly source: string; readonly request: string }
): Promise<LiveTurn> => {
  let source: string | null = null
  let delegated = false
  const eventsAfterDelegation: Array<StreamEvent> = []
  const context: AgentContext = {
    emit: (event) =>
      Effect.sync(() => {
        if (delegated) eventsAfterDelegation.push(event)
      }),
    canUseTool: () => Effect.succeed("deny"),
    askQuestion: () => Effect.succeed([]),
    proposePlan: (plan: Plan) =>
      Effect.sync(() => {
        source = plan.raw
        delegated = true
        return PlanDecision.Delegate()
      }),
    registerBackgroundStop: () => Effect.void,
    registerTurnSteer: () => Effect.void
  }
  const spec: SessionSpec = {
    cli: route.cli,
    repo: "jingler-orchestrator-eval",
    branch: "eval",
    cwd: process.cwd(),
    prompt: evalPrompt(route, catalogue, amendment),
    images: [],
    binPath,
    mode: "plan",
    model: route.model,
    planTemplate: DEFAULT_PLAN_TEMPLATE_HTML,
    orchestrationRoutes: catalogue,
    resumeId: null,
    fresh: true,
    readOnly: true
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* CliAdapter
      yield* adapter.run(
        `orchestrator-eval-${route.cli}-${route.model.replaceAll("/", "-")}`,
        spec,
        context
      )
    }).pipe(Effect.provide(HarnessCliAdapterLive))
  )
  return { source, delegated, eventsAfterDelegation }
}

const failedHarnessReport = (
  route: OrchestratorEvalRoute,
  evidence: string
): OrchestratorEvalReport => ({
  route,
  passed: false,
  assertions: [{ id: "plan-only", passed: false, evidence }]
})

const evaluateRoute = async (
  route: OrchestratorEvalRoute,
  catalogue: ReadonlyArray<OrchestrationRoute>
): Promise<ReadonlyArray<OrchestratorEvalReport>> => {
  const binPath = findExecutable(route.cli)
  if (binPath === null) {
    return [
      failedHarnessReport(
        route,
        `${route.cli} is unavailable; set JINGLER_ORCHESTRATOR_${route.cli.toUpperCase()}_BIN`
      )
    ]
  }
  try {
    const initial = await runLiveTurn(route, binPath, catalogue)
    const initialReport = evaluateOrchestratorProcedure({
      route,
      source: initial.source,
      availableRoutes: catalogue,
      delegated: initial.delegated,
      eventsAfterDelegation: initial.eventsAfterDelegation
    })
    if (initial.source === null) return [initialReport]

    const request = "Immutable audit entries record the initiating user id."
    const amended = await runLiveTurn(route, binPath, catalogue, {
      source: initial.source,
      request
    })
    const amendmentReport = evaluateOrchestratorProcedure({
      route,
      source: amended.source,
      previousSource: initial.source,
      expectedAmendment: request,
      availableRoutes: catalogue,
      delegated: amended.delegated,
      eventsAfterDelegation: amended.eventsAfterDelegation
    })
    return [initialReport, amendmentReport]
  } catch (error) {
    return [
      failedHarnessReport(
        route,
        error instanceof Error ? error.message : String(error)
      )
    ]
  }
}

const main = async (): Promise<void> => {
  const routes = configuredRoutes()
  const catalogue = routeCatalogue(routes)
  const reports = (
    await Promise.all(routes.map((route) => evaluateRoute(route, catalogue)))
  ).flat()
  for (const report of reports) {
    const label = `${report.route.cli}/${report.route.model}`
    for (const assertion of report.assertions) {
      console.log(
        `ORCHESTRATOR_EVAL route=${label} assertion=${assertion.id} status=${assertion.passed ? "passed" : "failed"} evidence=${assertion.evidence}`
      )
    }
  }
  if (reports.some((report) => !report.passed)) process.exitCode = 1
}

await main()
