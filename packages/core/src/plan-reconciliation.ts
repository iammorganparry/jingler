import type {
  PlanAcceptance,
  PlanAnnotation,
  PlanCommentMessage,
  PlanPrd,
  PlanPrdStage,
  PlanTask
} from "./plan-document.js"

export interface PlanReconciliationDiagnostic {
  readonly code: "running-stage-removed"
  readonly message: string
  readonly stageId: string
}

export type PlanAmendmentReconciliation =
  | {
      readonly valid: true
      readonly plan: PlanPrd
      /** Existing stages with semantic changes plus every newly-added stage. */
      readonly changedStageIds: ReadonlyArray<string>
    }
  | {
      readonly valid: false
      readonly diagnostics: ReadonlyArray<PlanReconciliationDiagnostic>
    }

/**
 * Stable semantic identity for one stage. Task status and per-criterion
 * evidence/status are mechanical and deliberately
 * omitted, so re-issuing a plan with the same semantics never re-queues settled
 * work. Task text, concrete test references, and diagram identities remain
 * semantic because changing any of them changes what the stage promises.
 */
export const planStageSemanticFingerprint = (stage: PlanPrdStage): string =>
  JSON.stringify({
    id: stage.id,
    title: stage.title,
    intent: stage.intent,
    dependencies: [...(stage.dependencies ?? [])].sort(),
    complexity: stage.complexity ?? "medium",
    approach: stage.approach,
    tasks: (stage.tasks ?? []).map((task) => ({ id: task.id, text: task.text })),
    files: [...stage.files]
      .map((file) => ({ path: file.path, change: file.change }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    diagrams: stage.diagrams.map((diagram) => ({ id: diagram.id, source: diagram.source })),
    notes: stage.notes,
    walkthrough: stage.walkthrough ?? [],
    callPathDiff: stage.callPathDiff ?? null,
    acceptance: stage.acceptance.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      testReferences: (criterion.testReferences ?? []).map((reference) => ({
        path: reference.path,
        cases: reference.cases
      }))
    }))
  })

const stagesById = (stages: ReadonlyArray<PlanPrdStage>): Map<string, PlanPrdStage> =>
  new Map(stages.map((stage) => [stage.id, stage]))

/**
 * Merge a prior comment thread with the replacement's copy. The PREVIOUS thread
 * is authoritative — an operator may have edited its status or messages — and
 * only genuinely new replacement messages (e.g. a fresh agent reply) are
 * appended, de-duplicated by id.
 */
const mergeAnnotation = (
  previous: PlanAnnotation,
  replacement: PlanAnnotation
): PlanAnnotation => {
  const seen = new Set(previous.messages.map((message) => message.id))
  const extra: Array<PlanCommentMessage> = []
  for (const message of replacement.messages) {
    if (message.id.length === 0 || seen.has(message.id)) continue
    seen.add(message.id)
    extra.push(message)
  }
  return { ...previous, messages: [...previous.messages, ...extra] }
}

const reconcileAcceptance = (
  previous: PlanPrdStage | undefined,
  replacement: PlanPrdStage,
  stageChanged: boolean
): ReadonlyArray<PlanAcceptance> => {
  const previousCriteria = new Map(
    (previous?.acceptance ?? []).map((criterion) => [criterion.id, criterion])
  )
  return replacement.acceptance.map((criterion) => {
    const prior = previousCriteria.get(criterion.id)
    const normalized = { ...criterion, testReferences: criterion.testReferences ?? [] }
    return !stageChanged && prior !== undefined && prior.text === criterion.text
      ? { ...normalized, status: prior.status, evidence: prior.evidence }
      : { ...normalized, status: "pending" as const, evidence: null }
  })
}

/** Preserve mechanical progress only while a task id keeps the same semantic text. */
const reconcileTasks = (
  previous: PlanPrdStage | undefined,
  replacement: PlanPrdStage
): ReadonlyArray<PlanTask> => {
  const previousTasks = new Map((previous?.tasks ?? []).map((task) => [task.id, task]))
  return (replacement.tasks ?? []).map((task) => {
    const prior = previousTasks.get(task.id)
    return prior !== undefined && prior.text === task.text
      ? { ...task, status: prior.status }
      : { ...task, status: "pending" as const }
  })
}

/**
 * Reconcile a producing-agent replacement plan with durable progress.
 *
 * The replacement owns semantics. Stable unchanged criteria keep their prior
 * status + evidence; changed/new criteria are forced pending. Task progress is
 * preserved while stable ids retain the same text. Prior comment threads are
 * preserved (and merged) unless the caller opts out for a checked user edit.
 */
export const reconcilePlanAmendment = (
  previous: PlanPrd,
  replacement: PlanPrd,
  options: {
    /**
     * Agent-authored replacements may omit comment threads they did not
     * reproduce, so preserve them by default. A revision-checked user edit
     * already starts from the latest plan; omission there is an intentional
     * delete and must be honoured.
     */
    readonly preserveAnnotations?: boolean
  } = {}
): PlanAmendmentReconciliation => {
  const previousStages = stagesById(previous.stages)
  const changedStageIds: Array<string> = []
  const reconciledStages = replacement.stages.map((replacementStage) => {
    const previousStage = previousStages.get(replacementStage.id)
    const changed =
      previousStage === undefined ||
      planStageSemanticFingerprint(previousStage) !==
        planStageSemanticFingerprint(replacementStage)
    if (changed) changedStageIds.push(replacementStage.id)

    const acceptance = reconcileAcceptance(previousStage, replacementStage, changed)
    const tasks = reconcileTasks(previousStage, replacementStage)

    return {
      ...replacementStage,
      tasks,
      acceptance
    }
  })

  // Preserve/merge prior comment threads onto the replacement.
  const replacementAnnotations = new Map(
    replacement.annotations.map((annotation) => [annotation.id, annotation])
  )
  const annotations: Array<PlanAnnotation> = replacement.annotations.map((annotation) => {
    const prior = previous.annotations.find((candidate) => candidate.id === annotation.id)
    return prior === undefined ? annotation : mergeAnnotation(prior, annotation)
  })
  if (options.preserveAnnotations !== false) {
    for (const prior of previous.annotations) {
      if (!replacementAnnotations.has(prior.id)) annotations.push(prior)
    }
  }

  return {
    valid: true,
    plan: { ...replacement, stages: reconciledStages, annotations },
    changedStageIds
  }
}
