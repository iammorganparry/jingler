import {
  planDocumentToPlan,
  planStageSemanticFingerprint,
  planTaskProgressRecords,
  resumePlanPrompt,
  stripPlanTaskProgressProtocol,
  type Plan,
  type PlanDocument,
  type PlanTaskProgressRecord
} from "@jingler/core"
import { createHash } from "node:crypto"

export type PlanTaskProgressMarker = PlanTaskProgressRecord

/** Compact, copy-safe identity for one stage's immutable semantics. */
export const planTaskProgressFingerprint = (
  stage: PlanDocument["plan"]["stages"][number]
): string =>
  createHash("sha256")
    .update(planStageSemanticFingerprint(stage))
    .digest("hex")
    .slice(0, 24)

/** Parse the provider-neutral task checkpoint protocol from accumulated output. */
export const planTaskProgressFromText = (
  text: string
): ReadonlyArray<PlanTaskProgressMarker> => planTaskProgressRecords(text)

/** Hide task checkpoint markers from the user-facing assistant response. */
export { stripPlanTaskProgressProtocol }

/**
 * Add exact durable checkpoints to the compatibility plan handed to a direct
 * execution turn. Completed work is explicit, so a fresh harness can continue
 * a partially-finished plan without repeating it after restart.
 */
export const planWithExecutionProgress = (document: PlanDocument): Plan => {
  const projected = planDocumentToPlan(document)
  const checkpoints = document.plan.stages.flatMap((stage) => [
    `Stage ${stage.id} fingerprint=${planTaskProgressFingerprint(stage)} execution=${stage.executionStatus ?? "queued"}`,
    ...(stage.tasks ?? []).map(
      (task, index) => `${index + 1}. [${task.status}] ${task.id} — ${task.text}`
    ),
    ...stage.acceptance.map(
      (criterion) =>
        `Criterion ${criterion.id} [${criterion.status}] — ${criterion.text}`
    )
  ])
  return {
    ...projected,
    raw: [projected.raw, "Execution checkpoints:", ...checkpoints].join("\n\n")
  }
}

export const resumeCanonicalPlanPrompt = (document: PlanDocument): string =>
  resumePlanPrompt(planWithExecutionProgress(document))
