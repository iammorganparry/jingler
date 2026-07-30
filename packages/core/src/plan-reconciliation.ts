import { type HTMLElement, parse } from "node-html-parser"
import type {
  PlanAcceptance,
  PlanDocument,
  PlanPrd,
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageExecutionStatus
} from "./plan-document.js"
import {
  type PlanHtmlDiagnostic,
  type PlanHtmlResult,
  parsePlanHtml,
  sanitizePlanHtml
} from "./plan-html.js"

export type PlanAmendmentReconciliation =
  | {
      readonly valid: true
      /** Sanitized canonical HTML after mechanical state has been reconciled. */
      readonly source: string
      readonly projection: PlanPrd
      /** Existing stages with semantic changes plus every newly-added stage. */
      readonly changedStageIds: ReadonlyArray<string>
    }
  | {
      readonly valid: false
      readonly source: string
      readonly projection: null
      readonly diagnostics: ReadonlyArray<PlanHtmlDiagnostic>
      readonly cause: "previous" | "replacement" | "reconciled"
    }

const stageElements = (root: HTMLElement): Map<string, HTMLElement> =>
  new Map(
    root
      .querySelectorAll("section[data-stage]")
      .map((element) => [element.getAttribute("data-stage") ?? "", element])
  )

/**
 * Stable semantic identity for one dispatched stage. Worker status, assignment,
 * evidence, and annotation resolution are mechanical and deliberately omitted.
 */
export const planStageSemanticFingerprint = (stage: PlanPrdStage): string => {
  const root = parse(`<section>${stage.markdown}</section>`)
  const element = root.querySelector("section")
  if (element === null) return ""
  for (const assignment of element.querySelectorAll("[data-assignment]")) {
    assignment.remove()
  }
  for (const criterion of element.querySelectorAll("[data-acceptance]")) {
    criterion.remove()
  }
  for (const annotation of element.querySelectorAll("[data-annotation]")) {
    annotation.remove()
  }
  return JSON.stringify({
    id: stage.id,
    title: stage.title,
    intent: stage.intent,
    dependencies: [...(stage.dependencies ?? [])].sort(),
    complexity: stage.complexity ?? "medium",
    acceptance: stage.acceptance.map((criterion) => ({
      id: criterion.id,
      text: criterion.text
    })),
    // Tiptap and the sanitizer may add harmless paragraph wrappers. Text order
    // is semantic; those serialization details are not.
    body: element.structuredText.replace(/\s+/g, " ").trim()
  })
}

const ensureAssignmentElement = (stage: HTMLElement): HTMLElement => {
  const existing = stage.querySelector("[data-assignment]")
  if (existing !== null) return existing
  stage.insertAdjacentHTML("afterbegin", '<div data-assignment=""></div>')
  return stage.querySelector("[data-assignment]")!
}

const writeStageRouting = (
  stageElement: HTMLElement,
  assignment: PlanStageAssignment | null,
  status: PlanStageExecutionStatus
): void => {
  if (assignment === null) {
    stageElement.setAttribute("data-execution-status", status)
    return
  }
  stageElement.removeAttribute("data-execution-status")
  const element = ensureAssignmentElement(stageElement)
  element.setAttribute("data-assignment", "")
  element.setAttribute("data-agent-id", assignment.agentId)
  element.setAttribute("data-cli", assignment.cli)
  element.setAttribute("data-model", assignment.model)
  element.setAttribute("data-reason", assignment.reason)
  element.setAttribute("data-status", status)
}

const stagesById = (stages: ReadonlyArray<PlanPrdStage>): Map<string, PlanPrdStage> =>
  new Map(stages.map((stage) => [stage.id, stage]))

const criteriaById = (
  stages: ReadonlyArray<PlanPrdStage>
): Map<string, PlanAcceptance> => {
  const criteria = new Map<string, PlanAcceptance>()
  for (const stage of stages) {
    for (const criterion of stage.acceptance) criteria.set(criterion.id, criterion)
  }
  return criteria
}

const invalidResult = (
  result: Extract<PlanHtmlResult, { readonly valid: false }>,
  cause: "previous" | "replacement" | "reconciled"
): PlanAmendmentReconciliation => ({
  valid: false,
  source: result.html,
  projection: null,
  diagnostics: result.diagnostics,
  cause
})

const reconcileStages = (
  replacementElements: ReadonlyMap<string, HTMLElement>,
  previousStages: ReadonlyMap<string, PlanPrdStage>,
  replacementStages: ReadonlyMap<string, PlanPrdStage>
): ReadonlyArray<string> => {
  const changedStageIds: Array<string> = []
  for (const [stageId, replacementElement] of replacementElements) {
    const previousStage = previousStages.get(stageId)
    const replacementStage = replacementStages.get(stageId)
    if (replacementStage === undefined) continue
    const changed =
      previousStage === undefined ||
      planStageSemanticFingerprint(previousStage) !==
        planStageSemanticFingerprint(replacementStage)
    if (changed) changedStageIds.push(stageId)
    const assignment =
      previousStage?.assignment ?? replacementStage.assignment ?? null
    const previousStatus = previousStage?.executionStatus ?? "queued"
    const status: PlanStageExecutionStatus =
      previousStage === undefined
        ? "queued"
        : previousStatus === "completed" && changed
          ? "queued"
          : previousStatus
    writeStageRouting(replacementElement, assignment, status)
  }
  return changedStageIds
}

const reconcileCriteria = (
  replacementRoot: HTMLElement,
  previousCriteria: ReadonlyMap<string, PlanAcceptance>,
  replacementCriteria: ReadonlyMap<string, PlanAcceptance>
): void => {
  for (const criterionElement of replacementRoot.querySelectorAll("[data-acceptance]")) {
    const criterionId = criterionElement.getAttribute("data-acceptance") ?? ""
    const current = replacementCriteria.get(criterionId)
    const prior = previousCriteria.get(criterionId)
    if (prior !== undefined && current !== undefined && prior.text === current.text) {
      criterionElement.setAttribute("data-status", prior.status)
      if (prior.evidence === null || prior.evidence.length === 0) {
        criterionElement.removeAttribute("data-evidence")
      } else {
        criterionElement.setAttribute("data-evidence", prior.evidence)
      }
    } else {
      criterionElement.setAttribute("data-status", "pending")
      criterionElement.removeAttribute("data-evidence")
    }
  }
}

/**
 * Reconcile an orchestrator-authored replacement with durable worker state.
 *
 * The replacement owns semantics. Stable unchanged criteria keep their prior
 * evidence; changed/new criteria are forced pending. Existing stages keep their
 * logical assignee and execution state, except a semantically changed completed
 * stage is queued again for that same assignee.
 */
export const reconcilePlanAmendment = (
  previousDocument: PlanDocument,
  replacementHtml: string
): PlanAmendmentReconciliation => {
  const previous = parsePlanHtml(previousDocument.source)
  if (!previous.valid) return invalidResult(previous, "previous")
  const replacement = parsePlanHtml(replacementHtml)
  if (!replacement.valid) return invalidResult(replacement, "replacement")

  const replacementRoot = parse(sanitizePlanHtml(replacement.html))
  const replacementElements = stageElements(replacementRoot)
  const previousStages = stagesById(previous.projection.stages)
  const replacementStages = stagesById(replacement.projection.stages)
  const removedRunning = previous.projection.stages.filter(
    (stage) =>
      stage.executionStatus === "running" &&
      !replacementStages.has(stage.id)
  )
  if (removedRunning.length > 0) {
    return {
      valid: false,
      source: replacement.html,
      projection: null,
      diagnostics: removedRunning.map((stage) => ({
        code: "running-stage-removed" as const,
        message: `Running stage "${stage.id}" cannot be removed. Stop its worker before removing the stage.`
      })),
      cause: "replacement"
    }
  }
  const changedStageIds = reconcileStages(
    replacementElements,
    previousStages,
    replacementStages
  )
  reconcileCriteria(
    replacementRoot,
    criteriaById(previous.projection.stages),
    criteriaById(replacement.projection.stages)
  )

  const reconciled = parsePlanHtml(replacementRoot.toString())
  if (!reconciled.valid) return invalidResult(reconciled, "reconciled")
  return {
    valid: true,
    source: reconciled.html,
    projection: reconciled.projection,
    changedStageIds
  }
}
