import { buildPlanExecutionGraph } from "./plan-execution.js"
import type {
  PlanAcceptance,
  PlanBlock,
  PlanDiagram,
  PlanFile,
  PlanPrd,
  PlanPrdSection,
  PlanPrdStage,
  PlanTask,
  PlanStageComplexity,
  PlanStageExecutionStatus
} from "./plan-document.js"

export type { PlanDiagram } from "./plan-document.js"

/**
 * Pure, framework-free view models for the three plan UI surfaces (steps,
 * architecture, workflow graph). Everything here is a derived projection of the
 * canonical `PlanPrd`: no React, no filesystem, no Effect. File lists, diagrams,
 * and prose are structured fields on the plan, so these projections read them
 * directly and reuse `buildPlanExecutionGraph` for dependency-topological order.
 */

/** One plan stage projected for the step-oriented review surface. */
export interface PlanStepView {
  readonly id: string
  readonly title: string
  readonly intent: string
  /** Planner complexity estimate; undefined when the stage never declared one. */
  readonly complexity: PlanStageComplexity | undefined
  /** Durable worker state; defaults to "queued" for not-yet-executed stages. */
  readonly executionStatus: PlanStageExecutionStatus
  readonly acceptance: ReadonlyArray<PlanAcceptance>
  /** Planner-authored work items with durable per-task progress. */
  readonly tasks?: ReadonlyArray<PlanTask>
  /** Architecture owned by this stage, preserving planner-authored ids. */
  readonly diagrams?: ReadonlyArray<PlanDiagram>
  /** Ordered approach steps. */
  readonly approach: ReadonlyArray<string>
  /** Structured file declarations. */
  readonly files: ReadonlyArray<PlanFile>
  /** Remaining rich prose blocks for the stage body. */
  readonly notes: ReadonlyArray<PlanBlock>
  /** The assigned worker's agent id, when a worker owns this stage; else null. */
  readonly agentId: string | null
  /** A short "cli · model" worker label, when assigned; else null. */
  readonly worker: string | null
  /** The worker's reasoning effort (e.g. "xhigh"), when set; else null. */
  readonly reasoningEffort: string | null
}

/** One stage's architecture, kept linked to the Main review card by stage id. */
export interface PlanArchitectureStageView {
  readonly id: string
  readonly title: string
  readonly diagrams: ReadonlyArray<PlanDiagram>
}

/** Document prose plus stage-owned architecture groups. */
export interface PlanArchitectureView {
  readonly sections: ReadonlyArray<PlanPrdSection>
  readonly stages: ReadonlyArray<PlanArchitectureStageView>
}

/** One node per stage in the dependency workflow graph. */
export interface PlanWorkflowNode {
  readonly id: string
  readonly stageId: string
  readonly title: string
  readonly complexity: PlanStageComplexity | undefined
  readonly executionStatus: PlanStageExecutionStatus
  /** The assigned worker's agent id, when a worker owns this stage; else null. */
  readonly agentId: string | null
  /** A short "cli · model" worker label for the node, when assigned; else null. */
  readonly worker: string | null
}

/** A directed edge from a prerequisite stage (`from`) to a dependent (`to`). */
export interface PlanWorkflowEdge {
  readonly id: string
  readonly from: string
  readonly to: string
}

/** Nodes in dependency-topological order; edges with dangling ids dropped. */
export interface PlanWorkflowGraph {
  readonly nodes: ReadonlyArray<PlanWorkflowNode>
  readonly edges: ReadonlyArray<PlanWorkflowEdge>
}

/** The full plan projection consumed by the three UI surfaces. */
export interface PlanView {
  readonly steps: ReadonlyArray<PlanStepView>
  readonly architecture: PlanArchitectureView
  readonly workflow: PlanWorkflowGraph
}

const toStepView = (stage: PlanPrdStage): PlanStepView => {
  const assignment = stage.assignment ?? null
  return {
    id: stage.id,
    title: stage.title,
    intent: stage.intent,
    complexity: stage.complexity,
    executionStatus: stage.executionStatus ?? "queued",
    acceptance: stage.acceptance,
    tasks: stage.tasks ?? [],
    diagrams: stage.diagrams,
    approach: stage.approach,
    files: stage.files,
    notes: stage.notes,
    agentId: assignment?.agentId ?? null,
    worker: assignment ? `${assignment.cli} · ${assignment.model}` : null,
    reasoningEffort: assignment?.reasoning?.effort ?? null
  }
}

/**
 * Dependency-topological stage order. `buildPlanExecutionGraph` groups stages by
 * connected component then orders each component topologically (source order as
 * the tie-breaker); flattening the groups yields a single valid topological
 * ordering over every stage. Any stage the graph didn't place (e.g. an isolated
 * one) is appended in source order.
 *
 * Stages are keyed by `id`, which must be unique — the graph, react-flow node
 * ids and step keys all require it — so a duplicate id necessarily collapses to
 * a single stage (the last occurrence, per Map semantics) rather than being kept
 * twice. Duplicate ids are invalid input, not a supported case.
 */
const orderedStages = (prd: PlanPrd): Array<PlanPrdStage> => {
  const stageById = new Map(prd.stages.map((stage) => [stage.id, stage]))
  const graph = buildPlanExecutionGraph(prd.stages)
  const seen = new Set<string>()
  const ordered: Array<PlanPrdStage> = []
  for (const id of graph.groups.flatMap((group) => group.stageIds)) {
    const stage = stageById.get(id)
    if (stage === undefined || seen.has(id)) continue
    seen.add(id)
    ordered.push(stage)
  }
  for (const stage of prd.stages) {
    if (seen.has(stage.id)) continue
    seen.add(stage.id)
    ordered.push(stage)
  }
  return ordered
}

/** One `PlanStepView` per stage, in dependency-topological/execution order. */
export const toPlanStepViews = (prd: PlanPrd): Array<PlanStepView> =>
  orderedStages(prd).map(toStepView)

/**
 * Prose sections (verbatim) plus stage-owned mermaid diagrams. Stage and diagram
 * ids survive projection so Architecture can link back to the corresponding
 * Main card. Blank diagrams are ignored; empty stages need no architecture group.
 */
export const toPlanArchitectureView = (prd: PlanPrd): PlanArchitectureView => {
  return {
    sections: prd.sections,
    stages: orderedStages(prd).flatMap((stage) => {
      const diagrams = stage.diagrams
        .map((diagram) => ({ ...diagram, source: diagram.source.trim() }))
        .filter((diagram) => diagram.source.length > 0)
      return diagrams.length > 0
        ? [{ id: stage.id, title: stage.title, diagrams }]
        : []
    })
  }
}

/**
 * Directed dependency graph over the stages. Nodes are topologically ordered;
 * edges point from each declared dependency to the depending stage. Dependency
 * ids that reference no stage (dangling) and self-references are ignored rather
 * than throwing.
 */
export const stagesToGraph = (prd: PlanPrd): PlanWorkflowGraph => {
  const stageById = new Map(prd.stages.map((stage) => [stage.id, stage]))
  const nodes: Array<PlanWorkflowNode> = orderedStages(prd).map((stage) => {
    const assignment = stage.assignment ?? null
    return {
      id: stage.id,
      stageId: stage.id,
      title: stage.title,
      complexity: stage.complexity,
      executionStatus: stage.executionStatus ?? "queued",
      agentId: assignment?.agentId ?? null,
      worker: assignment ? `${assignment.cli} · ${assignment.model}` : null
    }
  })

  const edges: Array<PlanWorkflowEdge> = []
  const edgeIds = new Set<string>()
  for (const stage of prd.stages) {
    for (const dependency of stage.dependencies ?? []) {
      if (dependency === stage.id || !stageById.has(dependency)) continue
      const id = `${dependency}->${stage.id}`
      if (edgeIds.has(id)) continue
      edgeIds.add(id)
      edges.push({ id, from: dependency, to: stage.id })
    }
  }
  return { nodes, edges }
}

/** Convenience selector returning all three plan view projections at once. */
export const toPlanView = (prd: PlanPrd): PlanView => ({
  steps: toPlanStepViews(prd),
  architecture: toPlanArchitectureView(prd),
  workflow: stagesToGraph(prd)
})
