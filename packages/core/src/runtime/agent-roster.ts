import { Schema } from "effect"

export const AgentRosterEntry = Schema.Struct({
  chatId: Schema.String,
  title: Schema.String,
  status: Schema.Literal("idle", "running", "needs-input"),
  task: Schema.NullOr(Schema.String),
  planStage: Schema.NullOr(Schema.String),
  touchedFiles: Schema.Array(Schema.String),
  updatedAt: Schema.String
})
export type AgentRosterEntry = typeof AgentRosterEntry.Type

export const PeerAgentMessageResult = Schema.Struct({
  status: Schema.Literal("delivered", "unavailable", "rejected"),
  targetChatId: Schema.String
})
export type PeerAgentMessageResult = typeof PeerAgentMessageResult.Type
