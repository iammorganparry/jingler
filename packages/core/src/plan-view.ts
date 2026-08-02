import { parse } from "node-html-parser"
import type { PlanFileChange } from "./conversation.js"
import { buildPlanExecutionGraph } from "./plan-execution.js"
import type {
  PlanAcceptance,
  PlanPrd,
  PlanPrdSection,
  PlanPrdStage,
  PlanStageComplexity,
  PlanStageExecutionStatus
} from "./plan-document.js"

/**
 * Pure, framework-free view models for the three plan UI surfaces (steps,
 * architecture, workflow graph). Everything here is a derived projection of the
 * canonical `PlanPrd`: no React, no Tiptap, no filesystem, no Effect. The plan
 * document keeps file lists and mermaid diagrams inside HTML `markdown` strings
 * (there is no dedicated projection field for either), so this module re-parses
 * those strings with the same small HTML dialect the rest of `@jingler/core`
 * uses, and reuses `buildPlanExecutionGraph` for dependency-topological order.
 */

/** A single mermaid diagram lifted out of a section/stage markdown string. */
export interface PlanDiagram {
  readonly id: string
  readonly source: string
}

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
  /** Parsed from the stage's `<ul data-files>` declaration; empty when absent. */
  readonly files: ReadonlyArray<PlanFileChange>
  /** The raw stage body HTML, verbatim from the projection. */
  readonly markdown: string
}

/** Prose sections plus every mermaid diagram found across the document. */
export interface PlanArchitectureView {
  readonly sections: ReadonlyArray<PlanPrdSection>
  readonly diagrams: ReadonlyArray<PlanDiagram>
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

const CHANGE_KINDS = new Set(["A", "M", "D"])

/** Parse `<ul data-files><li data-change data-added data-removed>path</li></ul>`. */
const filesFrom = (markdown: string): Array<PlanFileChange> => {
  const list = parse(markdown).querySelector("ul[data-files]")
  if (list === null) return []
  return list
    .querySelectorAll("li")
    .map((li) => {
      const change = (li.getAttribute("data-change") ?? "M").toUpperCase()
      return {
        path: li.text.trim(),
        change: (CHANGE_KINDS.has(change) ? change : "M") as "A" | "M" | "D",
        added: Number(li.getAttribute("data-added") ?? "0") || 0,
        removed: Number(li.getAttribute("data-removed") ?? "0") || 0
      }
    })
    .filter((file) => file.path.length > 0)
}

/** Extract every `<div data-diagram="mermaid">` source from one markdown string. */
const diagramSourcesFrom = (markdown: string): Array<string> => {
  if (markdown.trim().length === 0) return []
  return parse(markdown)
    .querySelectorAll("[data-diagram]")
    .filter((el) => el.getAttribute("data-diagram") === "mermaid")
    .map((el) => (el.querySelector("pre") ?? el).text.trim())
    .filter((source) => source.length > 0)
}

const toStepView = (stage: PlanPrdStage): PlanStepView => ({
  id: stage.id,
  title: stage.title,
  intent: stage.intent,
  complexity: stage.complexity,
  executionStatus: stage.executionStatus ?? "queued",
  acceptance: stage.acceptance,
  files: filesFrom(stage.markdown),
  markdown: stage.markdown
})

/**
 * Dependency-topological stage order. `buildPlanExecutionGraph` groups stages by
 * connected component then orders each component topologically (source order as
 * the tie-breaker); flattening the groups yields a single valid topological
 * ordering over every stage. Any stage the graph dropped (e.g. a duplicate id)
 * is appended in source order so no stage is silently lost.
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
 * Prose sections (verbatim) plus every mermaid diagram found across those
 * sections and the stages, ordered sections-first then stages, and assigned
 * stable sequential ids. Empty arrays when the plan carries neither.
 */
export const toPlanArchitectureView = (prd: PlanPrd): PlanArchitectureView => {
  const sources = [
    ...prd.sections.flatMap((section) => diagramSourcesFrom(section.markdown)),
    ...prd.stages.flatMap((stage) => diagramSourcesFrom(stage.markdown))
  ]
  return {
    sections: prd.sections,
    diagrams: sources.map((source, index) => ({
      id: `diagram-${index + 1}`,
      source
    }))
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
