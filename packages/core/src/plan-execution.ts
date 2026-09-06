import type { PlanFile, PlanPrd, PlanPrdStage, PlanStageComplexity } from "./plan-document.js"

export type PlanExecutionDiagnosticCode =
  | "duplicate-stage"
  | "self-dependency"
  | "dangling-dependency"
  | "dependency-cycle"
  | "invalid-file-path"
  | "duplicate-acceptance"

export interface PlanExecutionDiagnostic {
  readonly code: PlanExecutionDiagnosticCode
  readonly message: string
  readonly stageIds: ReadonlyArray<string>
}

/** A dependency-connected set of stages in stable topological order. */
export interface PlanExecutionGroup {
  readonly id: string
  readonly stageIds: ReadonlyArray<string>
  readonly complexity: PlanStageComplexity
  readonly files: ReadonlyArray<PlanFile>
}

export interface PlanExecutionGraph {
  readonly valid: boolean
  readonly groups: ReadonlyArray<PlanExecutionGroup>
  readonly diagnostics: ReadonlyArray<PlanExecutionDiagnostic>
}

const complexityRank: Record<PlanStageComplexity, number> = {
  low: 0,
  medium: 1,
  high: 2
}

const maxComplexity = (stages: ReadonlyArray<PlanPrdStage>): PlanStageComplexity =>
  stages.reduce<PlanStageComplexity>((highest, stage) => {
    const candidate = stage.complexity ?? "medium"
    return complexityRank[candidate] > complexityRank[highest] ? candidate : highest
  }, "low")

const invalidRepositoryPath = (path: string): boolean =>
  path.length === 0 ||
  path.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(path) ||
  path.split(/[\\/]/).some((segment) => segment === "..")

const collectComponent = (root: string, neighbors: ReadonlyMap<string, Set<string>>): Set<string> => {
  const component = new Set<string>()
  const pending = [root]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (component.has(id)) continue
    component.add(id)
    for (const neighbor of neighbors.get(id) ?? []) pending.push(neighbor)
  }
  return component
}

const connectNeighbors = (stageById: ReadonlyMap<string, PlanPrdStage>, neighbors: Map<string, Set<string>>): void => {
  for (const stage of stageById.values()) {
    for (const dependency of stage.dependencies ?? []) {
      if (!neighbors.has(dependency) || dependency === stage.id) continue
      neighbors.get(stage.id)?.add(dependency)
      neighbors.get(dependency)?.add(stage.id)
    }
  }
}

const connectDependencies = (
  unique: ReadonlyArray<PlanPrdStage>,
  ids: ReadonlySet<string>,
  outgoing: Map<string, Set<string>>,
  indegree: Map<string, number>
): void => {
  for (const stage of unique) {
    for (const dependency of stage.dependencies ?? []) {
      if (!ids.has(dependency) || dependency === stage.id) continue
      if (!outgoing.get(dependency)!.has(stage.id)) {
        outgoing.get(dependency)!.add(stage.id)
        indegree.set(stage.id, (indegree.get(stage.id) ?? 0) + 1)
      }
    }
  }
}

const stageDiagnostics = (stage: PlanPrdStage, ids: ReadonlySet<string>, diagnostics: Array<PlanExecutionDiagnostic>): void => {
  for (const dependency of stage.dependencies ?? []) {
    if (dependency === stage.id) diagnostics.push({
      code: "self-dependency",
      message: `Stage "${stage.id}" cannot depend on itself.`,
      stageIds: [stage.id]
    })
    else if (!ids.has(dependency)) diagnostics.push({
      code: "dangling-dependency",
      message: `Stage "${stage.id}" depends on unknown stage "${dependency}".`,
      stageIds: [stage.id]
    })
  }
  for (const file of stage.files) {
    if (invalidRepositoryPath(file.path)) diagnostics.push({
      code: "invalid-file-path",
      message: `Stage "${stage.id}" must use a repository-relative file path.`,
      stageIds: [stage.id]
    })
  }
}

const graphDiagnostics = (
  stages: ReadonlyArray<PlanPrdStage>
): Array<PlanExecutionDiagnostic> => {
  const diagnostics: Array<PlanExecutionDiagnostic> = []
  const counts = new Map<string, number>()
  for (const stage of stages) counts.set(stage.id, (counts.get(stage.id) ?? 0) + 1)
  for (const [id, count] of counts) {
    if (count > 1) diagnostics.push({
      code: "duplicate-stage",
      message: `Stage id "${id}" is declared more than once.`,
      stageIds: [id]
    })
  }

  const ids = new Set(stages.map((stage) => stage.id))
  for (const stage of stages) stageDiagnostics(stage, ids, diagnostics)
  return diagnostics
}

const topologicalOrder = (
  stages: ReadonlyArray<PlanPrdStage>,
  diagnostics: Array<PlanExecutionDiagnostic>
): Array<string> => {
  const index = new Map(stages.map((stage, position) => [stage.id, position]))
  const unique = [...new Map(stages.map((stage) => [stage.id, stage])).values()]
  const ids = new Set(unique.map((stage) => stage.id))
  const indegree = new Map(unique.map((stage) => [stage.id, 0]))
  const outgoing = new Map(unique.map((stage) => [stage.id, new Set<string>()]))
  connectDependencies(unique, ids, outgoing, indegree)
  const ready = unique
    .filter((stage) => indegree.get(stage.id) === 0)
    .map((stage) => stage.id)
    .sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
  const ordered: Array<string> = []
  while (ready.length > 0) {
    const id = ready.shift()!
    ordered.push(id)
    for (const dependent of outgoing.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)
      if (next === 0) {
        ready.push(dependent)
        ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
      }
    }
  }
  const cyclic = unique.map((stage) => stage.id).filter((id) => !ordered.includes(id))
  if (cyclic.length > 0) diagnostics.push({
    code: "dependency-cycle",
    message: `Plan stages contain a dependency cycle: ${cyclic.join(", ")}.`,
    stageIds: cyclic
  })
  return [...ordered, ...cyclic]
}

export const buildPlanExecutionGraph = (
  stages: ReadonlyArray<PlanPrdStage>
): PlanExecutionGraph => {
  const diagnostics = graphDiagnostics(stages)
  const order = topologicalOrder(stages, diagnostics)
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const neighbors = new Map(order.map((id) => [id, new Set<string>()]))
  connectNeighbors(stageById, neighbors)
  const seen = new Set<string>()
  const groups: Array<PlanExecutionGroup> = []
  for (const root of order) {
    if (seen.has(root)) continue
    const component = collectComponent(root, neighbors)
    for (const id of component) seen.add(id)
    const stageIds = order.filter((id) => component.has(id))
    const componentStages = stageIds.flatMap((id) => {
      const stage = stageById.get(id)
      return stage === undefined ? [] : [stage]
    })
    const files = [...new Map(
      componentStages.flatMap((stage) => stage.files).map((file) => [`${file.change}:${file.path}`, file])
    ).values()]
    groups.push({
      id: stageIds[0] ?? `group-${groups.length + 1}`,
      stageIds,
      complexity: maxComplexity(componentStages),
      files
    })
  }
  return { valid: diagnostics.length === 0, groups, diagnostics }
}

export const planStructuralDiagnostics = (
  plan: PlanPrd
): ReadonlyArray<PlanExecutionDiagnostic> => {
  const diagnostics = [...buildPlanExecutionGraph(plan.stages).diagnostics]
  const acceptance = new Map<string, string>()
  for (const stage of plan.stages) {
    for (const criterion of stage.acceptance) {
      const owner = acceptance.get(criterion.id)
      if (owner !== undefined) diagnostics.push({
        code: "duplicate-acceptance",
        message: `Acceptance id "${criterion.id}" is reused by stages "${owner}" and "${stage.id}".`,
        stageIds: [owner, stage.id]
      })
      else acceptance.set(criterion.id, stage.id)
    }
  }
  return diagnostics
}
