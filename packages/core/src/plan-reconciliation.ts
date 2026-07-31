import { type HTMLElement, parse } from "node-html-parser"
import type {
  PlanAcceptance,
  PlanDocument,
  PlanPrd,
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageExecutionStatus
} from "./plan-document.js"
import { writePlanAssignmentReasoningAttributes } from "./plan-assignment-html.js"
import {
  type PlanHtmlDiagnostic,
  type PlanHtmlResult,
  parsePlanHtml,
  sanitizePlanHtml,
  updatePlanAnnotationStatusHtml
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
  // HTML boolean-style attributes are semantically identical whether authored
  // as `data-files` or serialized by Tiptap as `data-files=""`.
  for (const files of element.querySelectorAll("[data-files]")) {
    files.setAttribute("data-files", "")
  }
  for (const paragraph of element.querySelectorAll("li > p")) {
    const parent = paragraph.parentNode
    const meaningfulChildren = parent.childNodes.filter(
      (child) => child.toString().trim().length > 0
    )
    if (meaningfulChildren.length === 1 && meaningfulChildren[0] === paragraph) {
      paragraph.replaceWith(...paragraph.childNodes)
    }
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
    // Preserve semantic attributes such as href and data-change while ignoring
    // only formatting whitespace and Tiptap's harmless list-item paragraph.
    body: element.innerHTML.replace(/>\s+</g, "><").trim()
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
  writePlanAssignmentReasoningAttributes(element, assignment.reasoning)
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
  const priorAgentsByReplacementAgent = new Map<string, Set<string>>()
  for (const [stageId, replacementStage] of replacementStages) {
    const replacementAgentId = replacementStage.assignment?.agentId
    const previousAgentId = previousStages.get(stageId)?.assignment?.agentId
    if (replacementAgentId === undefined || previousAgentId === undefined) continue
    const priorAgents =
      priorAgentsByReplacementAgent.get(replacementAgentId) ?? new Set<string>()
    priorAgents.add(previousAgentId)
    priorAgentsByReplacementAgent.set(replacementAgentId, priorAgents)
  }
  for (const [stageId, replacementElement] of replacementElements) {
    const previousStage = previousStages.get(stageId)
    const replacementStage = replacementStages.get(stageId)
    if (replacementStage === undefined) continue
    const changed =
      previousStage === undefined ||
      planStageSemanticFingerprint(previousStage) !==
        planStageSemanticFingerprint(replacementStage)
    if (changed) changedStageIds.push(stageId)
    const previousStatus = previousStage?.executionStatus ?? "queued"
    const replacementAssignment = replacementStage.assignment ?? null
    const previousAssignment = previousStage?.assignment ?? null
    const compatiblePriorAgents =
      replacementAssignment === null
        ? undefined
        : priorAgentsByReplacementAgent.get(replacementAssignment.agentId)
    const stableAgentId =
      compatiblePriorAgents?.size === 1
        ? [...compatiblePriorAgents][0]
        : replacementAssignment?.agentId
    const assignment =
      previousStatus === "running"
        ? previousAssignment ?? replacementAssignment
        : replacementAssignment === null || previousAssignment === null
          ? replacementAssignment ?? previousAssignment
          : {
              ...replacementAssignment,
              agentId: stableAgentId ?? replacementAssignment.agentId
            }
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

const reconcileAnnotations = (
  previousRoot: HTMLElement,
  replacementRoot: HTMLElement,
  replacementStageElements: ReadonlyMap<string, HTMLElement>
): void => {
  const canonicalAnnotation = (annotation: HTMLElement): HTMLElement | null => {
    const id = annotation.getAttribute("data-annotation") ?? ""
    const status =
      annotation.getAttribute("data-status") === "resolved" ? "resolved" : "open"
    const canonical =
      updatePlanAnnotationStatusHtml(annotation.toString(), id, status) ??
      annotation.toString()
    return parse(canonical).querySelector("[data-annotation]")
  }
  const replacementAnnotations = new Map(
    replacementRoot
      .querySelectorAll("[data-annotation]")
      .map((annotation) => [
        annotation.getAttribute("data-annotation") ?? "",
        annotation
      ])
  )
  for (const previousAnnotation of previousRoot.querySelectorAll(
    "[data-annotation]"
  )) {
    const annotationId =
      previousAnnotation.getAttribute("data-annotation") ?? ""
    if (annotationId.length === 0) continue
    const existing = replacementAnnotations.get(annotationId)
    const clone = canonicalAnnotation(previousAnnotation)
    if (clone === null) continue
    if (existing !== undefined) {
      const replacement = canonicalAnnotation(existing)
      const messageIds = new Set(
        clone
          .querySelectorAll("[data-comment-message]")
          .map((message) => message.getAttribute("data-comment-message") ?? "")
      )
      for (const message of replacement?.querySelectorAll(
        "[data-comment-message]"
      ) ?? []) {
        const messageId = message.getAttribute("data-comment-message") ?? ""
        if (messageId.length === 0 || messageIds.has(messageId)) continue
        clone.insertAdjacentHTML("beforeend", message.toString())
        messageIds.add(messageId)
      }
      existing.replaceWith(clone)
      continue
    }
    const stageId = previousAnnotation.getAttribute("data-stage")
    const target =
      stageId === undefined ? replacementRoot : replacementStageElements.get(stageId)
    const annotationParent = target ?? replacementRoot
    annotationParent.insertAdjacentHTML(
      "beforeend",
      previousAnnotation.toString()
    )
  }
}

const reconcileCriteria = (
  replacementRoot: HTMLElement,
  previousCriteria: ReadonlyMap<string, PlanAcceptance>,
  replacementCriteria: ReadonlyMap<string, PlanAcceptance>,
  changedCriterionIds: ReadonlySet<string>
): void => {
  for (const criterionElement of replacementRoot.querySelectorAll("[data-acceptance]")) {
    const criterionId = criterionElement.getAttribute("data-acceptance") ?? ""
    const current = replacementCriteria.get(criterionId)
    const prior = previousCriteria.get(criterionId)
    if (
      !changedCriterionIds.has(criterionId) &&
      prior !== undefined &&
      current !== undefined &&
      prior.text === current.text
    ) {
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
  replacementHtml: string,
  options: {
    /**
     * Agent-authored replacements may omit operational notes they did not
     * reproduce, so preserve them by default. A revision-checked user edit
     * already starts from the latest source; omission there is an intentional
     * delete and must be honoured.
     */
    readonly preserveAnnotations?: boolean
  } = {}
): PlanAmendmentReconciliation => {
  const previous = parsePlanHtml(previousDocument.source)
  if (!previous.valid) return invalidResult(previous, "previous")
  const replacement = parsePlanHtml(replacementHtml)
  if (!replacement.valid) return invalidResult(replacement, "replacement")

  const replacementRoot = parse(sanitizePlanHtml(replacement.html))
  const previousRoot = parse(sanitizePlanHtml(previous.html))
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
  const previousCriteria = criteriaById(previous.projection.stages)
  const replacementCriteria = criteriaById(replacement.projection.stages)
  const changedCriterionIds = new Set(
    changedStageIds.flatMap(
      (stageId) =>
        replacementStages.get(stageId)?.acceptance.map((criterion) => criterion.id) ??
        []
    )
  )
  reconcileCriteria(
    replacementRoot,
    previousCriteria,
    replacementCriteria,
    changedCriterionIds
  )
  if (options.preserveAnnotations !== false) {
    reconcileAnnotations(previousRoot, replacementRoot, replacementElements)
  }

  const reconciled = parsePlanHtml(replacementRoot.toString())
  if (!reconciled.valid) return invalidResult(reconciled, "reconciled")
  return {
    valid: true,
    source: reconciled.html,
    projection: reconciled.projection,
    changedStageIds
  }
}
