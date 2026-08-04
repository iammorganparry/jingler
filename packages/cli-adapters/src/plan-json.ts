import {
  decodePlanEmission,
  formatPlanEmissionDiagnostics,
  type PlanEmission,
  type WorkerRoutingConfig
} from "@jingler/core"
import type { OrchestrationRoute } from "./adapter.js"

/**
 * The agent's plan transport is a single fenced ` ```json ` block holding a
 * `PlanEmission` (`{ mode, plan }`). This module finds that block, decodes it
 * with typed diagnostics, and builds the authoring instructions — the JSON
 * replacement for the deleted HTML dialect.
 */

export interface PlanJsonBlock {
  /** The block including its fences, for stripping it from the transcript. */
  readonly block: string
  /** The JSON body between the fences. */
  readonly body: string
  readonly start: number
  readonly end: number
}

const FENCE = /(^|\n)[\t ]*(`{3,4})(?!`)json[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*\2[\t ]*(?=\r?\n|$)/i

/** The first fenced JSON block that looks like a plan emission (`"mode":`). */
export const extractPlanJsonBlock = (reply: string): PlanJsonBlock | null => {
  let search = 0
  while (search < reply.length) {
    const match = FENCE.exec(reply.slice(search))
    if (match === null) return null
    const body = match[3] ?? ""
    const leader = match[1] ?? ""
    const blockStart = search + match.index + leader.length
    const blockEnd = search + match.index + match[0].length
    if (/"mode"\s*:/.test(body)) {
      return { block: reply.slice(blockStart, blockEnd), body, start: blockStart, end: blockEnd }
    }
    search = blockEnd
  }
  return null
}

export type PlanCapture =
  | { readonly _tag: "emission"; readonly emission: PlanEmission; readonly block: string }
  | { readonly _tag: "reformat"; readonly message: string; readonly block: string }

/**
 * Find and decode a plan emission from an agent reply. Returns `emission` on a
 * clean decode, `reformat` (with typed diagnostics for a bounded retry) when a
 * plan block is present but malformed, or `null` when the reply carries no plan.
 */
export const capturePlanEmission = (reply: string): PlanCapture | null => {
  const block = extractPlanJsonBlock(reply)
  if (block === null) return null
  const result = decodePlanEmission(block.body)
  if (result.valid) return { _tag: "emission", emission: result.emission, block: block.block }
  return {
    _tag: "reformat",
    message: PLAN_JSON_REFORMAT(formatPlanEmissionDiagnostics(result.diagnostics)),
    block: block.block
  }
}

/** Remove the selected plan JSON block, preserving surrounding prose. */
export const stripPlanJsonBlock = (reply: string, block: string): string => {
  const index = reply.indexOf(block)
  if (index < 0) return reply.trim()
  return `${reply.slice(0, index)}${reply.slice(index + block.length)}`.replace(/\n{3,}/g, "\n\n").trim()
}

export const PLAN_JSON_REFORMAT = (diagnostics: string): string =>
  [
    "Your plan JSON did not decode. Re-emit the COMPLETE plan as one ```json block",
    "with these corrected:",
    diagnostics,
    "The block must be exactly { \"mode\": \"draft\"|\"submit\", \"plan\": { … } }."
  ].join("\n")

const STAGE_GRAMMAR = [
  "  Each stage: {",
  '    "id", "title", "intent",',
  '    "approach": string[], "files": [{ "path", "change": "A"|"M"|"D" }],',
  '    "diagrams": [{ "id", "source" }], "notes": PlanBlock[],',
  '    "acceptance": [{ "id", "text", "status": "pending", "evidence": null }],',
  '    "dependencies"?: string[], "complexity"?: "low"|"medium"|"high"',
  "  }",
  '  A PlanBlock is one of { "kind":"prose","id","text" } |',
  '  { "kind":"heading","id","level":2|3|4,"text" } | { "kind":"list","id","ordered","items":string[] } |',
  '  { "kind":"code","id","language"?,"code" } | { "kind":"table","id","headers":string[],"rows":string[][] } |',
  '  { "kind":"diagram","id","source" }.'
].join("\n")

/**
 * How a non-Claude harness submits a plan: one fenced JSON block. `mode:"draft"`
 * mirrors the plan into Plan Review as an editable draft with no approval gate;
 * `mode:"submit"` enters the single delegation approval gate. Never emit worker
 * assignments — Jingler routes those.
 */
export const planJsonInstructions = (
  _orchestration?: ReadonlyArray<OrchestrationRoute>,
  _workerRouting?: WorkerRoutingConfig
): string =>
  [
    "Submit a plan as ONE fenced ```json block containing exactly:",
    '{ "mode": "draft" | "submit", "plan": { "title": string, "sections": PlanPrdSection[],',
    '  "stages": PlanPrdStage[], "annotations": [] } }',
    'Use "draft" to iterate (it populates Plan Review with no approval gate) and "submit"',
    "to delegate (one approval gate). A prose preamble before the block is fine — the mode",
    "field decides, not position.",
    '  A PlanPrdSection: { "id", "title", "blocks": PlanBlock[] }.',
    STAGE_GRAMMAR,
    "Declare complexity, dependencies, files, and acceptance criteria.",
    "Do NOT add data-assignment: never emit worker assignments, agent ids, harnesses, models, or routes — Jingler assigns those."
  ].join("\n")
