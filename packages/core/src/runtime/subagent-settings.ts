import { Schema } from "effect"
import { ProviderModelId } from "./provider-connection.js"

export const JINGLER_SUBAGENT_NAMES = [
  "delegate",
  "oracle",
  "researcher",
  "reviewer",
  "scout",
  "worker",
  "fanout"
] as const

export const JinglerSubagentName = Schema.Literal(...JINGLER_SUBAGENT_NAMES)
export type JinglerSubagentName = typeof JinglerSubagentName.Type

export const SubagentModelAssignments = Schema.Struct({
  delegate: Schema.optional(ProviderModelId),
  oracle: Schema.optional(ProviderModelId),
  researcher: Schema.optional(ProviderModelId),
  reviewer: Schema.optional(ProviderModelId),
  scout: Schema.optional(ProviderModelId),
  worker: Schema.optional(ProviderModelId),
  fanout: Schema.optional(ProviderModelId)
})
export type SubagentModelAssignments = typeof SubagentModelAssignments.Type
