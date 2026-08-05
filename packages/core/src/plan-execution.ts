import type {
  PlanPrd,
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageComplexity,
  WorkerModelRoute,
  WorkerRoutingConfig
} from "./plan-document.js"
import { workerReasoningSettingIssue } from "./plan-document.js"
import type { ReasoningSetting } from "./domain.js"
import {
  AUTOMATIC_MODEL_PROVIDER_ORDER,
  modelCapabilityTier,
  type ModelCapabilityTier
} from "./models.js"

export type PlanExecutionDiagnosticCode =
  | "duplicate-stage"
  | "dangling-dependency"
  | "self-dependency"
  | "dependency-cycle"
  | "missing-assignment"
  | "assignment-conflict"
  | "invalid-file-path"
  | "missing-acceptance"
  | "duplicate-acceptance"

export interface PlanExecutionDiagnostic {
  readonly code: PlanExecutionDiagnosticCode
  readonly message: string
  readonly stageId: string | null
}

export interface PlanExecutionGroup {
  /** Stable logical worker id; assigned agent id when one is available. */
  readonly id: string
  /** Dependency-topological order, with source order as the stable tie-breaker. */
  readonly stageIds: ReadonlyArray<string>
  readonly complexity: PlanStageComplexity
  readonly assignment: PlanStageAssignment | null
  /** Exact declared paths whose overlap also joins otherwise-independent stages. */
  readonly files: ReadonlyArray<string>
}

export interface PlanExecutionGraph {
  readonly valid: boolean
  readonly groups: ReadonlyArray<PlanExecutionGroup>
  readonly diagnostics: ReadonlyArray<PlanExecutionDiagnostic>
}

export interface PlanExecutionGraphOptions {
  /** Approval/execution sets this; editing legacy plans leaves it false. */
  readonly requireAssignments?: boolean
}

export interface WorkerRouteCatalogEntry {
  readonly cli: WorkerModelRoute["cli"]
  readonly models: ReadonlyArray<{ readonly id: string }>
}

export type OrchestrationPlanCompilation =
  | {
      readonly valid: true
      readonly plan: PlanPrd
      readonly graph: PlanExecutionGraph
      readonly diagnostics: readonly []
    }
  | {
      readonly valid: false
      readonly plan: null
      readonly graph: PlanExecutionGraph | null
      readonly diagnostics: ReadonlyArray<PlanExecutionDiagnostic>
    }

export interface OrchestrationPlanCompilerOptions {
  /** The last canonical plan projection, used only as a stable identity source. */
  readonly previousStages?: ReadonlyArray<PlanPrdStage>
}

const COMPLEXITY_WEIGHT: Record<PlanStageComplexity, number> = {
  low: 0,
  medium: 1,
  high: 2
}

const complexityOf = (stage: PlanPrdStage): PlanStageComplexity =>
  stage.complexity ?? "medium"

const assignmentOf = (stage: PlanPrdStage): PlanStageAssignment | null =>
  stage.assignment ?? null

const dependenciesOf = (stage: PlanPrdStage): ReadonlyArray<string> =>
  stage.dependencies ?? []

/**
 * Normalize one planner-authored file declaration to a repository-relative key.
 * Both slash variants are accepted, but absolute paths and traversal outside
 * the repository are invalid.
 */
export const normalizePlanFilePath = (value: string): string | null => {
  const path = value.trim().replaceAll("\\", "/")
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes("\0")
  ) return null
  const segments: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join("/")
}

/** Normalize a stage's structured file declarations to repository-relative keys. */
const declaredFiles = (
  stage: PlanPrdStage
): {
  readonly files: ReadonlyArray<string>
  readonly invalid: ReadonlyArray<string>
} => {
  const files = new Set<string>()
  const invalid: Array<string> = []
  for (const file of stage.files) {
    const raw = file.path.trim()
    if (raw.length === 0) continue
    const normalized = normalizePlanFilePath(raw)
    if (normalized === null) invalid.push(raw)
    else files.add(normalized)
  }
  return { files: [...files], invalid }
}

const reasoningRoute = (reasoning: ReasoningSetting | undefined): string =>
  reasoning === undefined
    ? "provider-default"
    : `${reasoning.enabled ? "enabled" : "disabled"}\u0000${reasoning.effort ?? "provider-default"}`

const assignmentRoute = (assignment: PlanStageAssignment): string =>
  `${assignment.agentId}\u0000${assignment.cli}\u0000${assignment.model}\u0000${reasoningRoute(assignment.reasoning)}`

const workerRoutesEqual = (
  left: WorkerModelRoute,
  right: WorkerModelRoute
): boolean =>
  left.cli === right.cli &&
  left.model === right.model &&
  reasoningRoute(left.reasoning) === reasoningRoute(right.reasoning)

const routeAvailable = (
  route: WorkerModelRoute | undefined,
  catalog: ReadonlyArray<WorkerRouteCatalogEntry>
): route is WorkerModelRoute =>
  route !== undefined &&
  workerReasoningSettingIssue(route.cli, route.reasoning) === null &&
  catalog.some(
    (provider) =>
      provider.cli === route.cli &&
      provider.models.some((model) => model.id === route.model)
  )

const automaticWorkerRoutingConfig = (
  catalog: ReadonlyArray<WorkerRouteCatalogEntry>
): WorkerRoutingConfig | null => {
  const candidates = [...catalog]
    .sort(
      (left, right) =>
        AUTOMATIC_MODEL_PROVIDER_ORDER.indexOf(left.cli) -
        AUTOMATIC_MODEL_PROVIDER_ORDER.indexOf(right.cli)
    )
    .flatMap((provider) =>
      provider.models.map((model): WorkerModelRoute => ({
        cli: provider.cli,
        model: model.id
      }))
    )
  if (candidates.length === 0) return null

  const routeFor = (
    tiers: ReadonlyArray<ModelCapabilityTier>
  ): WorkerModelRoute =>
    tiers
      .map((tier) =>
        candidates.find((candidate) => modelCapabilityTier(candidate.model) === tier)
      )
      .find((candidate): candidate is WorkerModelRoute => candidate !== undefined) ??
    candidates[0]!

  const low = routeFor(["efficient", "balanced", "strongest"])
  const medium = routeFor(["balanced", "strongest", "efficient"])
  const high = routeFor(["strongest", "balanced", "efficient"])
  return { default: medium, low, medium, high }
}

/**
 * Resolve persisted worker routing against the same live catalogue used for
 * planner advertising and approval. Available saved routes remain authoritative;
 * each missing route returns to its own capability-tier automatic selection.
 * With no saved config, low, medium, and high resolve independently to efficient,
 * balanced, and strongest live models (collapsing safely when a tier is absent).
 */
export const resolveWorkerRoutingConfig = (
  configured: WorkerRoutingConfig | null | undefined,
  catalog: ReadonlyArray<WorkerRouteCatalogEntry>
): WorkerRoutingConfig | null => {
  const automatic = automaticWorkerRoutingConfig(catalog)
  if (automatic === null) return null
  if (configured === null || configured === undefined) return automatic
  const bucket = <Key extends keyof WorkerRoutingConfig>(
    key: Key
  ): WorkerRoutingConfig[Key] =>
    routeAvailable(configured[key], catalog) ? configured[key] : automatic[key]
  return {
    default: bucket("default"),
    low: bucket("low"),
    medium: bucket("medium"),
    high: bucket("high")
  }
}

const stagesWithoutAssignments = (
  stages: ReadonlyArray<PlanPrdStage>
): ReadonlyArray<PlanPrdStage> =>
  stages.map((stage) => ({ ...stage, assignment: null }))

const nextAgentId = (
  reservedAgentIds: ReadonlySet<string>,
  usedAgentIds: ReadonlySet<string>
): string => {
  let ordinal = 1
  while (true) {
    const candidate = `agent-${String(ordinal).padStart(2, "0")}`
    if (!(reservedAgentIds.has(candidate) || usedAgentIds.has(candidate))) {
      return candidate
    }
    ordinal += 1
  }
}

interface AgentIdAllocation {
  readonly group: PlanExecutionGroup
  readonly index: number
  readonly identityByStageId: ReadonlyMap<string, PlanPrdStage>
  readonly reservedAgentIds: ReadonlySet<string>
  readonly usedAgentIds: ReadonlySet<string>
  readonly reserveHistoricalIds: boolean
}

const allocateAgentId = ({
  group,
  index,
  identityByStageId,
  reservedAgentIds,
  usedAgentIds,
  reserveHistoricalIds
}: AgentIdAllocation): string => {
  const preferredAgentId = group.stageIds
    .map((stageId) => identityByStageId.get(stageId)?.assignment?.agentId)
    .find((agentId): agentId is string => agentId !== undefined)
  if (preferredAgentId !== undefined && !usedAgentIds.has(preferredAgentId)) {
    return preferredAgentId
  }
  if (reserveHistoricalIds) {
    return nextAgentId(reservedAgentIds, usedAgentIds)
  }
  const baseAgentId =
    preferredAgentId ?? `agent-${String(index + 1).padStart(2, "0")}`
  let agentId = baseAgentId
  let suffix = 2
  while (usedAgentIds.has(agentId)) {
    agentId = `${baseAgentId}-${suffix}`
    suffix += 1
  }
  return agentId
}

interface WorkerRoutingWriteOptions {
  readonly identityStages: ReadonlyArray<PlanPrdStage>
  readonly reserveHistoricalIds: boolean
}

/**
 * Assign each stage the operator's concrete complexity route by writing a
 * structured `assignment` field (no HTML). One connected component — joined by
 * dependencies and overlapping files — receives exactly one route and one
 * logical agent id, kept stable across recompiles where possible.
 */
const assignWorkerRouting = (
  stages: ReadonlyArray<PlanPrdStage>,
  routing: WorkerRoutingConfig,
  options: WorkerRoutingWriteOptions
): ReadonlyArray<PlanPrdStage> => {
  const graph = buildPlanExecutionGraph(stagesWithoutAssignments(stages))
  const identityByStageId = new Map(
    options.identityStages.map((stage) => [stage.id, stage])
  )
  const reservedAgentIds = new Set(
    options.identityStages.flatMap((stage) =>
      stage.assignment === null || stage.assignment === undefined
        ? []
        : [stage.assignment.agentId]
    )
  )
  const usedAgentIds = new Set<string>()
  const assignmentByStageId = new Map<string, PlanStageAssignment>()

  for (const [index, group] of graph.groups.entries()) {
    const agentId = allocateAgentId({
      group,
      index,
      identityByStageId,
      reservedAgentIds,
      usedAgentIds,
      reserveHistoricalIds: options.reserveHistoricalIds
    })
    usedAgentIds.add(agentId)
    const route = routing[group.complexity] ?? routing.default
    const reason =
      `Worker router selected ${route.cli}/${route.model} for this ` +
      `${group.complexity}-complexity dependency/file component.`
    for (const stageId of group.stageIds) {
      assignmentByStageId.set(stageId, {
        agentId,
        cli: route.cli,
        model: route.model,
        reason,
        ...(route.reasoning !== undefined ? { reasoning: route.reasoning } : {})
      })
    }
  }

  return stages.map((stage) => {
    const assignment = assignmentByStageId.get(stage.id) ?? null
    return { ...stage, assignment, executionStatus: "queued" }
  })
}

/**
 * Rewrite planner-authored assignments to the operator's concrete complexity
 * routes before the document becomes canonical.
 */
export const applyWorkerRouting = (
  stages: ReadonlyArray<PlanPrdStage>,
  routing: WorkerRoutingConfig
): ReadonlyArray<PlanPrdStage> =>
  assignWorkerRouting(stages, routing, {
    identityStages: stages,
    reserveHistoricalIds: false
  })

/** Strip operational state so only planner-owned semantics remain. */
const orchestrationSemantics = (plan: PlanPrd): PlanPrd => ({
  ...plan,
  stages: plan.stages.map((stage) => ({
    ...stage,
    assignment: null,
    executionStatus: undefined,
    acceptance: stage.acceptance.map((criterion) => ({
      ...criterion,
      status: "pending" as const,
      evidence: null
    }))
  }))
})

const invalidCompilation = (
  graph: PlanExecutionGraph | null,
  diagnostics: ReadonlyArray<PlanExecutionDiagnostic>
): Extract<OrchestrationPlanCompilation, { readonly valid: false }> => ({
  valid: false,
  plan: null,
  graph,
  diagnostics
})

/**
 * Compile planner-authored plan semantics into the canonical executable form.
 *
 * Operational assignment state is deliberately discarded: the planner owns
 * stages, dependencies, files, complexity, and acceptance criteria, while this
 * compiler owns stable worker identities and concrete execution routes.
 */
/**
 * Structural plan invariants that must hold on EVERY persist/submit path,
 * independent of routing or status: unique stage ids, no self/dangling
 * dependencies, no dependency cycles, repository-relative file paths, and
 * globally unique acceptance ids. Schema decoding alone accepts all of these —
 * and downstream views/mutations key by id, so a duplicate silently collapses
 * stages or applies evidence to the wrong target. Does NOT require acceptance
 * criteria (a draft may still be filling them in) — that is an execution-time
 * check enforced in `compileOrchestrationPlan`.
 */
/**
 * Codes that describe a broken plan STRUCTURE (addressability + dependency
 * integrity), as opposed to routing fitness (`missing-assignment`,
 * `assignment-conflict`) which is a scheduling concern enforced only when a plan
 * is compiled for execution. Persistence guards the former on every path.
 */
const STRUCTURAL_INTEGRITY_CODES: ReadonlySet<PlanExecutionDiagnosticCode> = new Set([
  "duplicate-stage",
  "dangling-dependency",
  "self-dependency",
  "dependency-cycle",
  "invalid-file-path"
])

export const planStructuralDiagnostics = (
  plan: PlanPrd
): ReadonlyArray<PlanExecutionDiagnostic> => {
  const graph = buildPlanExecutionGraph(plan.stages)
  const structural = graph.diagnostics.filter((diagnostic) =>
    STRUCTURAL_INTEGRITY_CODES.has(diagnostic.code)
  )
  const acceptanceOwner = new Map<string, string>()
  const duplicateAcceptance: Array<PlanExecutionDiagnostic> = []
  for (const stage of plan.stages) {
    for (const criterion of stage.acceptance) {
      const owner = acceptanceOwner.get(criterion.id)
      if (owner !== undefined) {
        duplicateAcceptance.push({
          code: "duplicate-acceptance",
          message: `Acceptance id "${criterion.id}" appears on stages "${owner}" and "${stage.id}".`,
          stageId: stage.id
        })
      } else {
        acceptanceOwner.set(criterion.id, stage.id)
      }
    }
  }
  return [...structural, ...duplicateAcceptance]
}

export const compileOrchestrationPlan = (
  plan: PlanPrd,
  routing: WorkerRoutingConfig,
  options: OrchestrationPlanCompilerOptions = {}
): OrchestrationPlanCompilation => {
  const semantic = orchestrationSemantics(plan)
  // Every stage must carry at least one acceptance criterion — a stage with no
  // verifiable outcome cannot be completed from evidence, so it is rejected
  // before routing rather than silently accepted.
  const acceptanceDiagnostics: ReadonlyArray<PlanExecutionDiagnostic> = semantic.stages
    .filter((stage) => stage.acceptance.length === 0)
    .map((stage) => ({
      code: "missing-acceptance" as const,
      message: `Stage "${stage.id}" needs at least one acceptance criterion.`,
      stageId: stage.id
    }))
  const structural = planStructuralDiagnostics(semantic)
  const semanticGraph = buildPlanExecutionGraph(semantic.stages)
  if (acceptanceDiagnostics.length > 0 || structural.length > 0) {
    return invalidCompilation(semanticGraph, [
      ...acceptanceDiagnostics,
      ...structural
    ])
  }
  const routedStages = assignWorkerRouting(semantic.stages, routing, {
    identityStages: options.previousStages ?? [],
    reserveHistoricalIds: true
  })
  const routedPlan: PlanPrd = { ...semantic, stages: routedStages }
  const graph = buildPlanExecutionGraph(routedStages, { requireAssignments: true })
  if (!graph.valid) {
    return invalidCompilation(graph, graph.diagnostics)
  }
  return { valid: true, plan: routedPlan, graph, diagnostics: [] }
}

/** Return the first canonical component that disagrees with the active router. */
export const workerRoutingMismatch = (
  stages: ReadonlyArray<PlanPrdStage>,
  routing: WorkerRoutingConfig
): PlanExecutionGroup | null => {
  const graph = buildPlanExecutionGraph(stages, { requireAssignments: true })
  return graph.groups.find((group) => {
    const expected = routing[group.complexity] ?? routing.default
    return (
      group.assignment !== null &&
      !workerRoutesEqual(group.assignment, expected)
    )
  }) ?? null
}

/**
 * Validate and group stages for provider-neutral execution.
 *
 * Dependencies form directed ordering edges and undirected ownership edges.
 * Exact file overlaps add ownership edges only. As a result, dependent work and
 * work that cannot safely edit concurrently share one logical worker, while
 * independent groups can be scheduled in parallel.
 */
export const buildPlanExecutionGraph = (
  stages: ReadonlyArray<PlanPrdStage>,
  options: PlanExecutionGraphOptions = {}
): PlanExecutionGraph => {
  const diagnostics: Array<PlanExecutionDiagnostic> = []
  const stageById = new Map<string, PlanPrdStage>()
  const sourceIndex = new Map<string, number>()

  for (const [index, stage] of stages.entries()) {
    if (stageById.has(stage.id)) {
      diagnostics.push({
        code: "duplicate-stage",
        message: `Stage "${stage.id}" appears more than once.`,
        stageId: stage.id
      })
      continue
    }
    stageById.set(stage.id, stage)
    sourceIndex.set(stage.id, index)
  }

  const parent = new Map<string, string>()
  for (const id of stageById.keys()) parent.set(id, id)

  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    let current = id
    while (current !== root) {
      const next = parent.get(current) ?? root
      parent.set(current, root)
      current = next
    }
    return root
  }

  const union = (left: string, right: string): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
  }

  for (const stage of stageById.values()) {
    for (const dependency of dependenciesOf(stage)) {
      if (dependency === stage.id) {
        diagnostics.push({
          code: "self-dependency",
          message: `Stage "${stage.id}" cannot depend on itself.`,
          stageId: stage.id
        })
        continue
      }
      if (!stageById.has(dependency)) {
        diagnostics.push({
          code: "dangling-dependency",
          message: `Stage "${stage.id}" depends on missing stage "${dependency}".`,
          stageId: stage.id
        })
        continue
      }
      union(stage.id, dependency)
    }
  }

  const declarations = new Map(
    [...stageById.values()].map((stage) => [stage.id, declaredFiles(stage)])
  )

  const firstStageByFile = new Map<string, string>()
  for (const stage of stageById.values()) {
    const declaration = declarations.get(stage.id)
    if (declaration === undefined) continue
    for (const path of declaration.invalid) {
      diagnostics.push({
        code: "invalid-file-path",
        message: `Stage "${stage.id}" declares "${path}", which must be a repository-relative path without traversal outside the repository.`,
        stageId: stage.id
      })
    }
    for (const path of declaration.files) {
      const first = firstStageByFile.get(path)
      if (first === undefined) firstStageByFile.set(path, stage.id)
      else union(first, stage.id)
    }
  }

  const visitState = new Map<string, "visiting" | "visited">()
  const visit = (stageId: string, path: ReadonlyArray<string>): void => {
    const state = visitState.get(stageId)
    if (state === "visited") return
    if (state === "visiting") {
      const cycleStart = path.indexOf(stageId)
      const cycle = [...path.slice(cycleStart), stageId]
      diagnostics.push({
        code: "dependency-cycle",
        message: `Dependency cycle detected: ${cycle.join(" -> ")}.`,
        stageId
      })
      return
    }
    visitState.set(stageId, "visiting")
    const stage = stageById.get(stageId)
    if (stage !== undefined) {
      for (const dependency of dependenciesOf(stage)) {
        if (dependency !== stageId && stageById.has(dependency)) {
          visit(dependency, [...path, stageId])
        }
      }
    }
    visitState.set(stageId, "visited")
  }
  for (const stageId of stageById.keys()) visit(stageId, [])

  if (options.requireAssignments === true) {
    for (const stage of stageById.values()) {
      if (assignmentOf(stage) === null) {
        diagnostics.push({
          code: "missing-assignment",
          message: `Stage "${stage.id}" needs a worker assignment before approval.`,
          stageId: stage.id
        })
      }
    }
  }

  const componentIds = new Map<string, Array<string>>()
  for (const stageId of stageById.keys()) {
    const root = find(stageId)
    const ids = componentIds.get(root) ?? []
    ids.push(stageId)
    componentIds.set(root, ids)
  }

  const components = [...componentIds.values()].sort((left, right) => {
    const leftIndex = Math.min(...left.map((id) => sourceIndex.get(id) ?? 0))
    const rightIndex = Math.min(...right.map((id) => sourceIndex.get(id) ?? 0))
    return leftIndex - rightIndex
  })

  const groups: Array<PlanExecutionGroup> = []
  const groupByAgentId = new Map<string, ReadonlyArray<string>>()
  for (const [groupIndex, component] of components.entries()) {
    const componentStages = component
      .map((id) => stageById.get(id))
      .filter((stage): stage is PlanPrdStage => stage !== undefined)
    const assignments = componentStages
      .map(assignmentOf)
      .filter((assignment): assignment is PlanStageAssignment => assignment !== null)
    const routes = new Set(assignments.map(assignmentRoute))
    if (routes.size > 1) {
      diagnostics.push({
        code: "assignment-conflict",
        message: `Connected stages ${component.map((id) => `"${id}"`).join(", ")} must use the same agent, harness, and model.`,
        stageId: component[0] ?? null
      })
    }

    const componentSet = new Set(component)
    const indegree = new Map<string, number>()
    const dependents = new Map<string, Array<string>>()
    for (const stage of componentStages) {
      indegree.set(stage.id, 0)
      dependents.set(stage.id, [])
    }
    for (const stage of componentStages) {
      for (const dependency of dependenciesOf(stage)) {
        if (!componentSet.has(dependency) || dependency === stage.id) continue
        indegree.set(stage.id, (indegree.get(stage.id) ?? 0) + 1)
        const children = dependents.get(dependency) ?? []
        children.push(stage.id)
        dependents.set(dependency, children)
      }
    }
    const bySourceOrder = (left: string, right: string): number =>
      (sourceIndex.get(left) ?? 0) - (sourceIndex.get(right) ?? 0)
    const ready = component.filter((id) => (indegree.get(id) ?? 0) === 0).sort(bySourceOrder)
    const ordered: Array<string> = []
    while (ready.length > 0) {
      const current = ready.shift()
      if (current === undefined) break
      ordered.push(current)
      for (const dependent of dependents.get(current) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1
        indegree.set(dependent, next)
        if (next === 0) {
          ready.push(dependent)
          ready.sort(bySourceOrder)
        }
      }
    }
    if (ordered.length !== component.length) {
      for (const id of component.sort(bySourceOrder)) {
        if (!ordered.includes(id)) ordered.push(id)
      }
    }

    const complexity = componentStages.reduce<PlanStageComplexity>(
      (strongest, stage) =>
        COMPLEXITY_WEIGHT[complexityOf(stage)] > COMPLEXITY_WEIGHT[strongest]
          ? complexityOf(stage)
          : strongest,
      "low"
    )
    const files = [
      ...new Set(componentStages.flatMap((stage) => declaredFiles(stage).files))
    ].sort()
    const assignment = assignments[0] ?? null
    if (assignment !== null) {
      const existingComponent = groupByAgentId.get(assignment.agentId)
      if (existingComponent === undefined) {
        groupByAgentId.set(assignment.agentId, component)
      } else {
        diagnostics.push({
          code: "assignment-conflict",
          message: `Agent "${assignment.agentId}" is assigned to independent stage groups ${existingComponent.map((id) => `"${id}"`).join(", ")} and ${component.map((id) => `"${id}"`).join(", ")}; use a distinct logical agent id for parallel execution.`,
          stageId: component[0] ?? null
        })
      }
    }
    groups.push({
      id: assignment?.agentId ?? `agent-${String(groupIndex + 1).padStart(2, "0")}`,
      stageIds: ordered,
      complexity,
      assignment,
      files
    })
  }

  return { valid: diagnostics.length === 0, groups, diagnostics }
}
