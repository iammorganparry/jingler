import type {
  CliKind,
  PlanPrdStage,
  StreamEvent
} from "@jingler/core"
import {
  buildPlanExecutionGraph,
  parsePlanHtml,
  supportsPlanMode
} from "@jingler/core"
import type { OrchestrationRoute } from "./adapter.js"

/** One concrete provider/model candidate exercised by the procedure eval. */
export interface OrchestratorEvalRoute {
  readonly cli: CliKind
  readonly model: string
}

/** Observable output from one planning or amendment turn. */
export interface OrchestratorEvalObservation {
  readonly route: OrchestratorEvalRoute
  readonly source: string | null
  readonly availableRoutes: ReadonlyArray<OrchestrationRoute>
  readonly delegated: boolean
  readonly eventsAfterDelegation: ReadonlyArray<StreamEvent>
  readonly previousSource?: string
  readonly expectedAmendment?: string
}

export interface OrchestratorEvalAssertion {
  readonly id:
    | "plan-only"
    | "canonical-html"
    | "assignments"
    | "dependency-ownership"
    | "available-routes"
    | "progress-ownership"
    | "stable-amendment"
  readonly passed: boolean
  readonly evidence: string
}

export interface OrchestratorEvalReport {
  readonly route: OrchestratorEvalRoute
  readonly passed: boolean
  readonly assertions: ReadonlyArray<OrchestratorEvalAssertion>
}

/**
 * Expand the live catalogue rather than maintaining a curated allow-list.
 * This is the seam used by a scheduled/live eval to cover every model a user
 * can actually select.
 */
export const expandOrchestratorEvalRoutes = (
  catalog: ReadonlyArray<OrchestrationRoute>
): ReadonlyArray<OrchestratorEvalRoute> =>
  catalog
    .filter((provider) => supportsPlanMode(provider.cli))
    .flatMap((provider) =>
      provider.models.map((model) => ({ cli: provider.cli, model: model.id }))
    )

/**
 * Small, cheap smoke matrix for local runs. Live catalogue expansion above is
 * the exhaustive route; Haiku is pinned here because weak-model compliance is
 * the regression this eval was introduced to detect.
 */
export const ORCHESTRATOR_EVAL_SMOKE_ROUTES: ReadonlyArray<OrchestratorEvalRoute> = [
  { cli: "claude", model: "haiku" },
  { cli: "codex", model: "gpt-5.6-sol" },
  { cli: "opencode", model: "opencode/big-pickle" }
]

const assignmentRoute = (stage: PlanPrdStage): string | null => {
  const assignment = stage.assignment
  return assignment == null ? null : `${assignment.cli}/${assignment.model}`
}

const mutationAfterHandoff = (event: StreamEvent): boolean =>
  event._tag === "ToolStart" || event._tag === "ToolEnd" || event._tag === "ToolDelta"

const previousStageIds = (source: string | undefined): ReadonlyArray<string> => {
  if (source === undefined) return []
  const parsed = parsePlanHtml(source)
  return parsed.valid ? parsed.projection.stages.map((stage) => stage.id) : []
}

/**
 * Grade procedure, not prose quality. All assertions are deterministic and
 * observable at the adapter boundary, so the same rubric works for Claude,
 * Codex, OpenCode, and every model exposed by their live catalogues.
 */
export const evaluateOrchestratorProcedure = (
  observation: OrchestratorEvalObservation
): OrchestratorEvalReport => {
  const parsed =
    observation.source === null ? null : parsePlanHtml(observation.source)
  const stages = parsed?.valid === true ? parsed.projection.stages : []
  const graph =
    stages.length === 0
      ? null
      : buildPlanExecutionGraph(stages, { requireAssignments: true })
  const allowedRoutes = new Set(
    observation.availableRoutes.flatMap((provider) =>
      provider.models.map((model) => `${provider.cli}/${model.id}`)
    )
  )
  const unassigned = stages.filter((stage) => stage.assignment == null)
  const unavailable = stages
    .map((stage) => assignmentRoute(stage))
    .filter((route): route is string => route !== null && !allowedRoutes.has(route))
  const plannerOwnedProgress = stages.flatMap((stage) => [
    ...(stage.executionStatus !== "queued" ? [stage.id] : []),
    ...stage.acceptance
      .filter(
        (criterion) =>
          criterion.status !== "pending" || criterion.evidence !== null
      )
      .map((criterion) => criterion.id)
  ])
  const oldIds = previousStageIds(observation.previousSource)
  const currentIds = new Set(stages.map((stage) => stage.id))
  const missingStableIds = oldIds.filter((id) => !currentIds.has(id))
  const amendmentPresent =
    observation.expectedAmendment === undefined ||
    observation.source?.includes(observation.expectedAmendment) === true

  const assertions: ReadonlyArray<OrchestratorEvalAssertion> = [
    {
      id: "plan-only",
      passed:
        observation.delegated &&
        !observation.eventsAfterDelegation.some(mutationAfterHandoff),
      evidence: observation.delegated
        ? `${observation.eventsAfterDelegation.filter(mutationAfterHandoff).length} mutating events after Delegate`
        : "planner never reached Jingler's Delegate handoff"
    },
    {
      id: "canonical-html",
      passed: parsed?.valid === true,
      evidence:
        parsed === null
          ? "no plan was proposed"
          : parsed.valid
            ? `${parsed.projection.stages.length} canonical stages parsed`
            : parsed.diagnostics.map((diagnostic) => diagnostic.message).join(" ")
    },
    {
      id: "assignments",
      passed: stages.length > 0 && unassigned.length === 0 && graph?.valid === true,
      evidence:
        unassigned.length === 0
          ? `${stages.length} stages carry validated assignments`
          : `unassigned stages: ${unassigned.map((stage) => stage.id).join(", ")}`
    },
    {
      id: "dependency-ownership",
      passed:
        graph?.diagnostics.every(
          (diagnostic) =>
            diagnostic.code !== "assignment-conflict" &&
            diagnostic.code !== "dependency-cycle" &&
            diagnostic.code !== "dangling-dependency" &&
            diagnostic.code !== "self-dependency"
        ) === true,
      evidence:
        graph === null
          ? "no dependency graph"
          : graph.diagnostics.length === 0
            ? `${graph.groups.length} dependency-safe worker groups`
            : graph.diagnostics.map((diagnostic) => diagnostic.message).join(" ")
    },
    {
      id: "available-routes",
      passed: stages.length > 0 && unavailable.length === 0,
      evidence:
        unavailable.length === 0
          ? "every assignment uses the supplied live route catalogue"
          : `unavailable routes: ${[...new Set(unavailable)].join(", ")}`
    },
    {
      id: "progress-ownership",
      passed: stages.length > 0 && plannerOwnedProgress.length === 0,
      evidence:
        plannerOwnedProgress.length === 0
          ? "planner left worker status queued and criteria pending without evidence"
          : `planner claimed worker progress: ${plannerOwnedProgress.join(", ")}`
    },
    {
      id: "stable-amendment",
      passed: missingStableIds.length === 0 && amendmentPresent,
      evidence:
        missingStableIds.length > 0
          ? `removed stable stage ids: ${missingStableIds.join(", ")}`
          : amendmentPresent
            ? `${oldIds.length} prior stage ids retained and amendment present`
            : `missing requested amendment: ${observation.expectedAmendment}`
    }
  ]

  return {
    route: observation.route,
    passed: assertions.every((assertion) => assertion.passed),
    assertions
  }
}
