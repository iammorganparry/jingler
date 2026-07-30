import { fencedHtmlPlan, stripHtmlPlanBlocks } from "./plan-parse.js"

/**
 * Pull an orchestrator amendment out of an auto-mode reply.
 *
 * Once its first plan is approved, the orchestrator no longer plans through a
 * gate — it works in auto mode. To change the plan it re-issues the COMPLETE
 * updated plan as one four-backtick ` ````html ` block (the same grammar it
 * drafted the first plan in). Jingler applies that block as an amendment
 * (`reconcilePlanAmendment` keeps stable ids and durable evidence, requeues
 * changed and new stages) and dispatches the affected workers — no approval.
 *
 * Returns the amendment HTML, or null when the reply carries no plan block (an
 * ordinary conversational turn) or a block with no `<section data-stage>` (an
 * illustration, not an amendment). Deliberately thin: `reconcilePlanAmendment`
 * owns the real validation, so this only decides "is this a plan amendment?".
 */
export const parseOrchestratorAmendment = (text: string): string | null => {
  const html = fencedHtmlPlan(text)
  if (html === null) return null
  // A plan amendment must carry at least one stage. A block without one is not
  // an amendment (e.g. the agent quoting HTML), so leave the plan untouched.
  if (!/<section[^>]*\bdata-stage\b/i.test(html)) return null
  return html
}

/**
 * Remove the amendment's ` ````html ` block from the reply the operator
 * sees. The block is machinery — once applied, the plan card carries the change,
 * so the raw HTML fence would only be noise in the transcript.
 */
export const stripOrchestratorAmendment = (text: string): string =>
  stripHtmlPlanBlocks(text)
