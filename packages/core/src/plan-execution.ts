import { parse } from "node-html-parser"
import type {
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageComplexity,
  WorkerModelRoute,
  WorkerRoutingConfig
} from "./plan-document.js"

export type PlanExecutionDiagnosticCode =
  | "duplicate-stage"
  | "dangling-dependency"
  | "self-dependency"
  | "dependency-cycle"
  | "missing-assignment"
  | "assignment-conflict"
  | "invalid-file-path"

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

/** Read the authoritative `<ul data-files>` declaration from a stage body. */
const declaredFiles = (
  stage: PlanPrdStage
): {
  readonly files: ReadonlyArray<string>
  readonly invalid: ReadonlyArray<string>
} => {
  const list = parse(stage.markdown).querySelector("ul[data-files]")
  if (list === null) return { files: [], invalid: [] }
  const files = new Set<string>()
  const invalid: Array<string> = []
  for (const item of list.querySelectorAll("li")) {
    const raw = item.text.trim()
    if (raw.length === 0) continue
    const normalized = normalizePlanFilePath(raw)
    if (normalized === null) invalid.push(raw)
    else files.add(normalized)
  }
  return { files: [...files], invalid }
}

const assignmentRoute = (assignment: PlanStageAssignment): string =>
  `${assignment.agentId}\u0000${assignment.cli}\u0000${assignment.model}`

const routeAvailable = (
  route: WorkerModelRoute | undefined,
  catalog: ReadonlyArray<WorkerRouteCatalogEntry>
): route is WorkerModelRoute =>
  route !== undefined &&
  catalog.some(
    (provider) =>
      provider.cli === route.cli &&
      provider.models.some((model) => model.id === route.model)
  )

/**
 * Resolve persisted worker routing against the same live catalogue used for
 * planner advertising and approval. An unavailable bucket falls back to the
 * configured default; an unavailable default falls back to the first live
 * planning route. With no saved config, every bucket uses that capability-first
 * route so a cheap orchestrator cannot downgrade implementation by accident.
 */
export const resolveWorkerRoutingConfig = (
  configured: WorkerRoutingConfig | null | undefined,
  catalog: ReadonlyArray<WorkerRouteCatalogEntry>
): WorkerRoutingConfig | null => {
  const firstProvider = catalog.find((provider) => provider.models.length > 0)
  const firstModel = firstProvider?.models[0]
  if (firstProvider === undefined || firstModel === undefined) return null
  const safeDefault: WorkerModelRoute = {
    cli: firstProvider.cli,
    model: firstModel.id
  }
  const fallback = routeAvailable(configured?.default, catalog)
    ? configured.default
    : safeDefault
  const bucket = (
    route: WorkerModelRoute | undefined
  ): WorkerModelRoute => routeAvailable(route, catalog) ? route : fallback
  return {
    default: fallback,
    low: bucket(configured?.low),
    medium: bucket(configured?.medium),
    high: bucket(configured?.high)
  }
}

const stagesWithoutAssignments = (
  stages: ReadonlyArray<PlanPrdStage>
): ReadonlyArray<PlanPrdStage> =>
  stages.map((stage) => ({ ...stage, assignment: null }))

/**
 * Rewrite planner-authored assignments to the operator's concrete complexity
 * routes before the document becomes canonical. Logical agent ids remain
 * stable where possible; dependencies and overlapping files still determine
 * ownership, so one connected component receives exactly one route.
 */
export const applyWorkerRoutingToPlanHtml = (
  html: string,
  stages: ReadonlyArray<PlanPrdStage>,
  routing: WorkerRoutingConfig
): string => {
  const graph = buildPlanExecutionGraph(stagesWithoutAssignments(stages))
  const root = parse(html)
  const stageElements = new Map(
    root
      .querySelectorAll("section[data-stage]")
      .map((element) => [element.getAttribute("data-stage") ?? "", element])
  )
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const usedAgentIds = new Set<string>()

  for (const [index, group] of graph.groups.entries()) {
    const preferredAgentId = group.stageIds
      .map((stageId) => stageById.get(stageId)?.assignment?.agentId)
      .find((agentId): agentId is string => agentId !== undefined)
    const baseAgentId =
      preferredAgentId ?? `agent-${String(index + 1).padStart(2, "0")}`
    let agentId = baseAgentId
    let suffix = 2
    while (usedAgentIds.has(agentId)) {
      agentId = `${baseAgentId}-${suffix}`
      suffix += 1
    }
    usedAgentIds.add(agentId)
    const route = routing[group.complexity] ?? routing.default
    const reason =
      `Worker router selected ${route.cli}/${route.model} for this ` +
      `${group.complexity}-complexity dependency/file component.`

    for (const stageId of group.stageIds) {
      const stage = stageElements.get(stageId)
      if (stage === undefined) continue
      let assignment = stage.querySelector("[data-assignment]")
      if (assignment === null) {
        stage.insertAdjacentHTML("afterbegin", "<div data-assignment></div>")
        assignment = stage.querySelector("[data-assignment]")
      }
      if (assignment === null) continue
      assignment.setAttribute("data-agent-id", agentId)
      assignment.setAttribute("data-cli", route.cli)
      assignment.setAttribute("data-model", route.model)
      assignment.setAttribute("data-reason", reason)
      assignment.setAttribute("data-status", "queued")
    }
  }
  return root.toString()
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
      (group.assignment.cli !== expected.cli ||
        group.assignment.model !== expected.model)
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

  const firstStageByFile = new Map<string, string>()
  for (const stage of stageById.values()) {
    const declaration = declaredFiles(stage)
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
