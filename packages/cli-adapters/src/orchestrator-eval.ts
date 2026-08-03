import type {
  CliKind,
  PlanPrd,
  PlanPrdStage
} from "@jingler/core"
import {
  buildPlanExecutionGraph,
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
  readonly plan: PlanPrd | null
  readonly availableRoutes: ReadonlyArray<OrchestrationRoute>
  readonly delegated: boolean
  readonly task?: {
    readonly boundedSingleOutcome: boolean
    readonly independentComponents?: number
    readonly specialistBenefit?: boolean
    readonly verificationHeavy?: boolean
    readonly changesApprovedPlan?: boolean
  }
  readonly directCompleted?: boolean
  readonly directVerified?: boolean
  readonly postHandoff?: {
    readonly monitored: boolean
    readonly workersSettled: boolean
    readonly steeringNeeded?: boolean
    readonly steered?: boolean
    readonly failedWorkerIds?: ReadonlyArray<string>
    readonly retriedWorkerIds?: ReadonlyArray<string>
    readonly integrated: boolean
    readonly finalReported: boolean
  }
  readonly previousPlan?: PlanPrd
  readonly expectedAmendment?: string
}

export interface OrchestratorEvalAssertion {
  readonly id:
    | "direct-when-bounded"
    | "delegate-when-beneficial"
    | "post-handoff-ownership"
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

const previousStableIds = (
  plan: PlanPrd | undefined
): {
  readonly stageIds: ReadonlyArray<string>
  readonly acceptanceIds: ReadonlyArray<string>
} => {
  if (plan === undefined) return { stageIds: [], acceptanceIds: [] }
  return {
    stageIds: plan.stages.map((stage) => stage.id),
    acceptanceIds: plan.stages.flatMap((stage) =>
      stage.acceptance.map((criterion) => criterion.id)
    )
  }
}

/**
 * Grade procedure, not prose quality. All assertions are deterministic and
 * observable at the adapter boundary, so the same rubric works for Claude,
 * Codex, OpenCode, and every model exposed by their live catalogues.
 */
export const evaluateOrchestratorProcedure = (
  observation: OrchestratorEvalObservation
): OrchestratorEvalReport => {
  const parsed = observation.plan
  const stages = parsed?.stages ?? []
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
  const previousIds = previousStableIds(observation.previousPlan)
  const currentStageIds = new Set(stages.map((stage) => stage.id))
  const currentAcceptanceIds = new Set(
    stages.flatMap((stage) =>
      stage.acceptance.map((criterion) => criterion.id)
    )
  )
  const missingStableIds = [
    ...previousIds.stageIds
      .filter((id) => !currentStageIds.has(id))
      .map((id) => `stage:${id}`),
    ...previousIds.acceptanceIds
      .filter((id) => !currentAcceptanceIds.has(id))
      .map((id) => `acceptance:${id}`)
  ]
  const amendmentPresent =
    observation.expectedAmendment === undefined ||
    (observation.plan !== null &&
      JSON.stringify(observation.plan).includes(observation.expectedAmendment))
  const independentComponents =
    observation.task?.independentComponents ?? graph?.groups.length ?? 0
  const delegationBeneficial =
    independentComponents > 1 ||
    observation.task?.specialistBenefit === true ||
    observation.task?.verificationHeavy === true ||
    observation.task?.changesApprovedPlan === true
  const directPreferred =
    observation.task?.boundedSingleOutcome === true && !delegationBeneficial
  const failedWorkerIds = observation.postHandoff?.failedWorkerIds ?? []
  const retriedWorkerIds = new Set(
    observation.postHandoff?.retriedWorkerIds ?? []
  )
  const unretriedFailures = failedWorkerIds.filter(
    (workerId) => !retriedWorkerIds.has(workerId)
  )
  const postHandoffOwned =
    observation.postHandoff?.monitored === true &&
    observation.postHandoff.workersSettled &&
    (observation.postHandoff.steeringNeeded !== true ||
      observation.postHandoff.steered === true) &&
    unretriedFailures.length === 0 &&
    observation.postHandoff.integrated &&
    observation.postHandoff.finalReported

  const assertions: ReadonlyArray<OrchestratorEvalAssertion> = [
    {
      id: "direct-when-bounded",
      passed:
        !directPreferred ||
        (!observation.delegated &&
          observation.directCompleted === true &&
          observation.directVerified === true),
      evidence: directPreferred
        ? observation.delegated
          ? "bounded single-outcome work was delegated despite coordination overhead"
          : `direct completion=${observation.directCompleted === true}, verification=${observation.directVerified === true}`
        : "task does not require the bounded-direct preference"
    },
    {
      id: "delegate-when-beneficial",
      passed: !delegationBeneficial || observation.delegated,
      evidence: delegationBeneficial
        ? observation.delegated
          ? `${independentComponents} independent components; beneficial delegation selected`
          : "focused delegation was skipped despite parallelism, specialist, verification, or amendment signals"
        : "no concrete delegation benefit detected"
    },
    {
      id: "post-handoff-ownership",
      passed: !observation.delegated || postHandoffOwned,
      evidence: observation.delegated
        ? postHandoffOwned
          ? "workers monitored and settled; steering/retries handled; result integrated and reported"
          : `monitoring/integration incomplete; unretried failures: ${unretriedFailures.join(", ") || "none"}`
        : "no handoff occurred"
    },
    {
      id: "canonical-html",
      passed: !observation.delegated || parsed !== null,
      evidence:
        !observation.delegated
          ? "direct execution needs no canonical worker plan"
          : parsed === null
            ? "no plan was proposed"
            : `${parsed.stages.length} canonical stages`
    },
    {
      id: "assignments",
      passed:
        !observation.delegated ||
        (stages.length > 0 && unassigned.length === 0 && graph?.valid === true),
      evidence:
        !observation.delegated
          ? "direct execution needs no worker assignments"
          : unassigned.length === 0
          ? `${stages.length} stages carry validated assignments`
          : `unassigned stages: ${unassigned.map((stage) => stage.id).join(", ")}`
    },
    {
      id: "dependency-ownership",
      passed:
        !observation.delegated ||
        graph?.diagnostics.every(
          (diagnostic) =>
            diagnostic.code !== "assignment-conflict" &&
            diagnostic.code !== "dependency-cycle" &&
            diagnostic.code !== "dangling-dependency" &&
            diagnostic.code !== "self-dependency"
        ) === true,
      evidence:
        !observation.delegated
          ? "direct execution has no worker dependency graph"
          : graph === null
          ? "no dependency graph"
          : graph.diagnostics.length === 0
            ? `${graph.groups.length} dependency-safe worker groups`
            : graph.diagnostics.map((diagnostic) => diagnostic.message).join(" ")
    },
    {
      id: "available-routes",
      passed:
        !observation.delegated ||
        (stages.length > 0 && unavailable.length === 0),
      evidence:
        !observation.delegated
          ? "direct execution has no worker route"
          : unavailable.length === 0
          ? "every assignment uses the supplied live route catalogue"
          : `unavailable routes: ${[...new Set(unavailable)].join(", ")}`
    },
    {
      id: "progress-ownership",
      passed:
        !observation.delegated ||
        (stages.length > 0 && plannerOwnedProgress.length === 0),
      evidence:
        !observation.delegated
          ? "direct executor owns its own verification"
          : plannerOwnedProgress.length === 0
          ? "planner left worker status queued and criteria pending without evidence"
          : `planner claimed worker progress: ${plannerOwnedProgress.join(", ")}`
    },
    {
      id: "stable-amendment",
      passed: missingStableIds.length === 0 && amendmentPresent,
      evidence:
        missingStableIds.length > 0
          ? `removed or renamed stable ids: ${missingStableIds.join(", ")}`
          : amendmentPresent
            ? `${previousIds.stageIds.length} stage ids and ${previousIds.acceptanceIds.length} acceptance ids retained; amendment present`
            : `missing requested amendment: ${observation.expectedAmendment}`
    }
  ]

  return {
    route: observation.route,
    passed: assertions.every((assertion) => assertion.passed),
    assertions
  }
}
