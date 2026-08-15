import { Schema } from "effect"
import { AgentRole, RuntimeMode } from "./agent-runtime.js"

export const SUBAGENT_CAPABILITY_VERSION = 1 as const

export type SubagentJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<SubagentJsonValue>
  | { readonly [key: string]: SubagentJsonValue }

export const SubagentJsonValue: Schema.Schema<SubagentJsonValue> = Schema.suspend(
  () => Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(SubagentJsonValue),
    Schema.Record({ key: Schema.String, value: SubagentJsonValue })
  )
)

export const SubagentToolInputSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  type: Schema.Literal("object"),
  properties: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Object })
  ),
  required: Schema.optional(Schema.Array(Schema.String)),
  additionalProperties: Schema.optional(Schema.Boolean)
})
export type SubagentToolInputSchema = Schema.Schema.Type<
  typeof SubagentToolInputSchema
>

export const SubagentCapabilityTool = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  inputSchema: SubagentToolInputSchema,
  risk: Schema.Literal("read", "network", "mutate", "execute")
})
export type SubagentCapabilityTool = Schema.Schema.Type<
  typeof SubagentCapabilityTool
>

/** Public launch contract written beside an ephemeral child credential. */
export const SubagentCapability = Schema.Struct({
  version: Schema.Literal(SUBAGENT_CAPABILITY_VERSION),
  endpoint: Schema.String,
  token: Schema.String,
  parentPiSessionId: Schema.String,
  targetId: Schema.String,
  role: AgentRole,
  mode: RuntimeMode,
  tools: Schema.Array(SubagentCapabilityTool)
})
export type SubagentCapability = Schema.Schema.Type<typeof SubagentCapability>

export const SubagentToolRequest = Schema.Struct({
  version: Schema.Literal(SUBAGENT_CAPABILITY_VERSION),
  token: Schema.String,
  parentPiSessionId: Schema.String,
  childAgent: Schema.String,
  callId: Schema.String,
  toolId: Schema.String,
  arguments: SubagentJsonValue
})
export type SubagentToolRequest = Schema.Schema.Type<typeof SubagentToolRequest>

export const SubagentToolResponse = Schema.Struct({
  version: Schema.Literal(SUBAGENT_CAPABILITY_VERSION),
  status: Schema.Literal("success", "error", "cancelled"),
  value: Schema.NullOr(SubagentJsonValue),
  preview: Schema.NullOr(Schema.String),
  error: Schema.NullOr(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      retryable: Schema.Boolean
    })
  )
})
export type SubagentToolResponse = Schema.Schema.Type<
  typeof SubagentToolResponse
>
