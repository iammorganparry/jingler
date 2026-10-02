import { Schema } from "effect"

export const ClaudeRequestUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.NonNegativeInt),
  output_tokens: Schema.optional(Schema.NonNegativeInt),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.NonNegativeInt)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.NonNegativeInt))
})
export type ClaudeRequestUsage = typeof ClaudeRequestUsage.Type

export const ClaudeTurnUsage = Schema.Struct({
  ...ClaudeRequestUsage.fields,
  iterations: Schema.optional(Schema.Array(ClaudeRequestUsage))
})
export type ClaudeTurnUsage = typeof ClaudeTurnUsage.Type

export const claudeUsageTokens = (usage: ClaudeRequestUsage): number =>
  (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
