import { Schema } from "effect"
import { StreamEvent } from "./conversation.js"
import { DiffStat, SessionStatus } from "./domain.js"
import { FileChangeSet } from "./runtime/file-change.js"

export const SESSION_PROTOCOL_VERSION = 1 as const

const SessionProtocolId = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(256)
)
const Sequence = Schema.Int.pipe(Schema.nonNegative())
const Revision = Schema.Int.pipe(Schema.nonNegative())

export const SessionEvent = Schema.Union(
  /** The existing harness-neutral stream seam used by the local renderer. */
  Schema.TaggedStruct("Stream", { event: StreamEvent }),
  Schema.TaggedStruct("StatusChanged", { status: SessionStatus }),
  Schema.TaggedStruct("DiffChanged", {
    /** Legacy per-path totals retained while older remote devices drain. */
    files: Schema.optional(Schema.Record({ key: Schema.String, value: DiffStat })),
    /** Canonical actual-workspace evidence from the remote pi runtime. */
    changes: Schema.optional(FileChangeSet)
  }).pipe(
    Schema.filter(
      (event) => event.files !== undefined || event.changes !== undefined,
      { message: () => "DiffChanged requires canonical changes or legacy file totals" }
    )
  ),
  Schema.TaggedStruct("PublishProgress", {
    phase: Schema.Literal("inspecting", "preparing", "publishing", "complete"),
    message: Schema.String
  }),
  Schema.TaggedStruct("Cancelled", { reason: Schema.String }),
  Schema.TaggedStruct("Terminal", {
    outcome: Schema.Literal("completed", "failed"),
    message: Schema.NullOr(Schema.String)
  })
)
export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>

/** Ordered, idempotent unit consumed by the conversation reducer. */
export const SessionEventEnvelope = Schema.Struct({
  version: Schema.Literal(SESSION_PROTOCOL_VERSION),
  eventId: SessionProtocolId,
  sessionId: SessionProtocolId,
  sequence: Schema.Int.pipe(Schema.positive()),
  revision: Revision,
  occurredAt: Schema.Int.pipe(Schema.nonNegative()),
  event: SessionEvent
})
export type SessionEventEnvelope = Schema.Schema.Type<
  typeof SessionEventEnvelope
>

export interface SessionEventCursor {
  readonly sequence: number
  readonly revision: number
  readonly eventIds: ReadonlyArray<string>
}

export type SessionEventAdmission =
  | { readonly status: "accepted"; readonly cursor: SessionEventCursor }
  | { readonly status: "duplicate" }
  | {
      readonly status: "sequence-gap"
      readonly expectedSequence: number
    }
  | { readonly status: "sequence-conflict" }
  | { readonly status: "stale-revision" }

const MAX_CURSOR_EVENT_IDS = 1_024

/**
 * Pure transport-independent admission fence for local, direct, and relayed
 * events. Reducers apply an envelope only after this returns `accepted`.
 */
export const admitSessionEvent = (
  cursor: SessionEventCursor,
  envelope: SessionEventEnvelope
): SessionEventAdmission => {
  if (envelope.sequence <= cursor.sequence) {
    return cursor.eventIds.includes(envelope.eventId)
      ? { status: "duplicate" }
      : { status: "sequence-conflict" }
  }
  if (envelope.sequence !== cursor.sequence + 1) {
    return {
      status: "sequence-gap",
      expectedSequence: cursor.sequence + 1
    }
  }
  if (envelope.revision < cursor.revision) return { status: "stale-revision" }
  return {
    status: "accepted",
    cursor: {
      sequence: envelope.sequence,
      revision: envelope.revision,
      eventIds: [...cursor.eventIds, envelope.eventId].slice(-MAX_CURSOR_EVENT_IDS)
    }
  }
}

export const isNextSessionEvent = (
  currentSequence: number,
  envelope: SessionEventEnvelope
): boolean => envelope.sequence === currentSequence + 1
