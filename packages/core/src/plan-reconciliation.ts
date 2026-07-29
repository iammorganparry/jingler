import { type HTMLElement, NodeType, parse } from "node-html-parser"
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

const sortAttributes = (element: HTMLElement): void => {
  const attributes = Object.entries(element.attributes).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  for (const name of Object.keys(element.attributes)) element.removeAttribute(name)
  for (const [name, value] of attributes) element.setAttribute(name, value)
  for (const child of element.childNodes) {
    if (child.nodeType === NodeType.ELEMENT_NODE) sortAttributes(child as HTMLElement)
  }
}

/**
 * A stage signature without orchestration's mechanical fields. Attribute order
 * and formatting whitespace are normalized so an editor serialize pass alone
 * cannot reopen completed work.
 */
const semanticStage = (element: HTMLElement): string => {
  const cloneRoot = parse(element.toString())
  const clone = cloneRoot.querySelector("section[data-stage]")
  if (clone === null) return ""
  clone.removeAttribute("data-execution-status")
  for (const assignment of clone.querySelectorAll("[data-assignment]")) assignment.remove()
  for (const criterion of clone.querySelectorAll("[data-acceptance]")) {
    criterion.removeAttribute("data-status")
    criterion.removeAttribute("data-evidence")
  }
  for (const annotation of clone.querySelectorAll("[data-annotation]")) {
    annotation.removeAttribute("data-status")
  }
  sortAttributes(clone)
  return clone.toString().replace(/>\s+</g, "><").trim()
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
  previousElements: ReadonlyMap<string, HTMLElement>,
  replacementElements: ReadonlyMap<string, HTMLElement>,
  previousStages: ReadonlyMap<string, PlanPrdStage>,
  replacementStages: ReadonlyMap<string, PlanPrdStage>
): ReadonlyArray<string> => {
  const changedStageIds: Array<string> = []
  for (const [stageId, replacementElement] of replacementElements) {
    const previousElement = previousElements.get(stageId)
    const changed =
      previousElement === undefined ||
      semanticStage(previousElement) !== semanticStage(replacementElement)
    if (changed) changedStageIds.push(stageId)

    const previousStage = previousStages.get(stageId)
    const replacementStage = replacementStages.get(stageId)
    if (replacementStage === undefined) continue
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

  const previousRoot = parse(previous.html)
  const replacementRoot = parse(sanitizePlanHtml(replacement.html))
  const previousElements = stageElements(previousRoot)
  const replacementElements = stageElements(replacementRoot)
  const previousStages = stagesById(previous.projection.stages)
  const replacementStages = stagesById(replacement.projection.stages)
  const changedStageIds = reconcileStages(
    previousElements,
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
