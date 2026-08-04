import { Either, ParseResult, Schema } from "effect"
import {
  PlanAcceptanceStatus,
  PlanPrd,
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageExecutionStatus
} from "./plan-document.js"

/**
 * What an orchestrator emits as a fenced ` ```json ` block. `mode` replaces the
 * old position-sensitive `<!-- jingler:submit-plan -->` marker: `draft`
 * populates Plan Review for iteration with no approval gate; `submit` enters the
 * one delegation approval gate. Because it is a typed field inside the decoded
 * object, a preamble before the block can never change its meaning.
 */
export const PlanEmissionMode = Schema.Literal("draft", "submit")
export type PlanEmissionMode = Schema.Schema.Type<typeof PlanEmissionMode>

export const PlanEmission = Schema.Struct({
  mode: PlanEmissionMode,
  plan: PlanPrd
})
export type PlanEmission = Schema.Schema.Type<typeof PlanEmission>

export interface PlanEmissionDiagnostic {
  /** Dotted path to the offending field (empty for whole-document errors). */
  readonly path: string
  readonly message: string
}

export type PlanEmissionResult =
  | { readonly valid: true; readonly emission: PlanEmission }
  | { readonly valid: false; readonly diagnostics: ReadonlyArray<PlanEmissionDiagnostic> }

const decodeEmission = Schema.decodeUnknownEither(PlanEmission, { errors: "all" })

/**
 * Decode an agent-emitted plan JSON string into a `PlanEmission`, or return
 * precise, fixable diagnostics. This is the replacement for the HTML compiler's
 * silent-drop behaviour: a missing/invalid field is a typed error the agent is
 * asked to correct, never an empty Plan Review.
 */
export const decodePlanEmission = (json: string): PlanEmissionResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return {
      valid: false,
      diagnostics: [{ path: "", message: `not valid JSON: ${(error as Error).message}` }]
    }
  }
  const result = decodeEmission(parsed)
  if (Either.isRight(result)) return { valid: true, emission: result.right }
  return {
    valid: false,
    diagnostics: ParseResult.ArrayFormatter.formatErrorSync(result.left).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  }
}

/** Human-readable one-per-line diagnostics for a reformat-retry prompt. */
export const formatPlanEmissionDiagnostics = (
  diagnostics: ReadonlyArray<PlanEmissionDiagnostic>
): string =>
  diagnostics
    .map((diagnostic) =>
      diagnostic.path.length > 0 ? `- ${diagnostic.path}: ${diagnostic.message}` : `- ${diagnostic.message}`
    )
    .join("\n")

/**
 * A granular update streamed to Plan Review so it fills in and reacts live —
 * during authoring (stages appear) and during execution (status/evidence flip)
 * — without re-sending the whole document.
 */
export const PlanDelta = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("SetTitle"), title: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("UpsertStage"),
    stage: PlanPrdStage,
    afterStageId: Schema.optional(Schema.NullOr(Schema.String))
  }),
  Schema.Struct({ _tag: Schema.Literal("RemoveStage"), stageId: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("SetAcceptanceStatus"),
    stageId: Schema.String,
    criterionId: Schema.String,
    status: PlanAcceptanceStatus,
    evidence: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    _tag: Schema.Literal("SetStageExecution"),
    stageId: Schema.String,
    status: PlanStageExecutionStatus
  }),
  Schema.Struct({
    _tag: Schema.Literal("SetAssignment"),
    stageId: Schema.String,
    assignment: Schema.NullOr(PlanStageAssignment)
  })
)
export type PlanDelta = Schema.Schema.Type<typeof PlanDelta>
