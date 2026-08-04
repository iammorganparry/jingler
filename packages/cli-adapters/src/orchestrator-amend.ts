import type { PlanPrd } from "@jingler/core"
import { capturePlanEmission, extractPlanJsonBlock, stripPlanJsonBlock } from "./plan-json.js"

/**
 * Pull an orchestrator amendment out of an auto-mode reply.
 *
 * Once its first plan is approved, the orchestrator no longer plans through a
 * gate — it works in auto mode. To change the plan it re-issues the COMPLETE
 * updated plan as one ` ```json ` emission block (the same grammar it drafted the
 * first plan in). Jingler applies that plan as an amendment
 * (`reconcilePlanAmendment` keeps stable ids and durable evidence, requeues
 * changed and new stages) and dispatches the affected workers — no approval.
 *
 * Returns the amendment plan, or null when the reply carries no decodable plan
 * block (an ordinary conversational turn) or a plan with no stages (an
 * illustration, not an amendment). Deliberately thin: `reconcilePlanAmendment`
 * owns the real validation, so this only decides "is this a plan amendment?".
 */
export const parseOrchestratorAmendment = (text: string): PlanPrd | null => {
  const capture = capturePlanEmission(text)
  if (capture === null || capture._tag !== "emission") return null
  const plan = capture.emission.plan
  return plan.stages.length > 0 ? plan : null
}

/**
 * Remove the amendment's ` ```json ` block from the reply the operator sees. The
 * block is machinery — once applied, the plan card carries the change, so the raw
 * JSON fence would only be noise in the transcript.
 */
export const stripOrchestratorAmendment = (text: string): string => {
  const block = extractPlanJsonBlock(text)
  return block === null ? text : stripPlanJsonBlock(text, block.block)
}
