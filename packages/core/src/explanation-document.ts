import { Schema } from "effect"
import { PlanBlock } from "./plan-document.js"

/**
 * Neutral name for Jingler's maintained generative-UI block contract.
 * `PlanBlock` remains the compatibility export for existing plan documents.
 */
export const VisualBlock = PlanBlock
export type VisualBlock = Schema.Schema.Type<typeof VisualBlock>

export const ExplanationSection = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  blocks: Schema.Array(VisualBlock)
})
export type ExplanationSection = Schema.Schema.Type<typeof ExplanationSection>

/** Agent-authored content accepted by the explanation publishing tool. */
export const ExplanationPayload = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  sections: Schema.Array(ExplanationSection)
})
export type ExplanationPayload = Schema.Schema.Type<typeof ExplanationPayload>

/** Latest durable explanation for one session. */
export const ExplanationDocument = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  producingChatId: Schema.String,
  revision: Schema.Number,
  title: Schema.String,
  summary: Schema.String,
  sections: Schema.Array(ExplanationSection),
  updatedAt: Schema.String
})
export type ExplanationDocument = Schema.Schema.Type<typeof ExplanationDocument>
