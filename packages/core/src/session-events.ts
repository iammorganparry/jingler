import { Schema } from "effect"
import {
  Attachment,
  GateDecision,
  Message,
  QuestionAnswer,
  StreamEvent
} from "./conversation.js"
import { DiffStat, SessionStatus } from "./domain.js"

export const SESSION_PROTOCOL_VERSION = 1 as const

const SessionProtocolId = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(256)
)
const Sequence = Schema.Int.pipe(Schema.nonNegative())
const Revision = Schema.Int.pipe(Schema.nonNegative())

export const SessionCommandPayload = Schema.Union(
  Schema.TaggedStruct("Prompt", {
    text: Schema.String,
    attachments: Schema.Array(Attachment)
  }),
  Schema.TaggedStruct("AnswerQuestions", {
    requestId: SessionProtocolId,
    answers: Schema.Array(QuestionAnswer)
  }),
  Schema.TaggedStruct("ResolveApproval", {
    gateId: SessionProtocolId,
    decision: GateDecision
  }),
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("RequestDiff", {}),
  Schema.TaggedStruct("Publish", {}),
  Schema.TaggedStruct("RequestTranscript", {
    afterSequence: Schema.NullOr(Sequence),
    limit: Schema.Int.pipe(Schema.between(1, 500))
  })
)
export type SessionCommandPayload = Schema.Schema.Type<
  typeof SessionCommandPayload
>

/**
 * Semantic command shared by local execution and every remote transport.
 * Transport authorization is deliberately separate from this payload.
 */
export const SessionCommand = Schema.Struct({
  version: Schema.Literal(SESSION_PROTOCOL_VERSION),
  commandId: SessionProtocolId,
  sessionId: SessionProtocolId,
  expectedRevision: Revision,
  controllerGeneration: Schema.Int.pipe(Schema.positive()),
  command: SessionCommandPayload
})
export type SessionCommand = Schema.Schema.Type<typeof SessionCommand>

export const SessionEvent = Schema.Union(
  /** The existing harness-neutral stream seam used by the local renderer. */
  Schema.TaggedStruct("Stream", { event: StreamEvent }),
  Schema.TaggedStruct("StatusChanged", { status: SessionStatus }),
  Schema.TaggedStruct("DiffChanged", {
    files: Schema.Record({ key: Schema.String, value: DiffStat })
  }),
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

export const SessionReplayRequest = Schema.Struct({
  version: Schema.Literal(SESSION_PROTOCOL_VERSION),
  sessionId: SessionProtocolId,
  afterSequence: Sequence,
  limit: Schema.Int.pipe(Schema.between(1, 500))
})
export type SessionReplayRequest = Schema.Schema.Type<
  typeof SessionReplayRequest
>

export const SessionSnapshot = Schema.Struct({
  version: Schema.Literal(SESSION_PROTOCOL_VERSION),
  sessionId: SessionProtocolId,
  revision: Revision,
  throughSequence: Sequence,
  status: SessionStatus,
  messages: Schema.Array(Message)
})
export type SessionSnapshot = Schema.Schema.Type<typeof SessionSnapshot>

export const SessionReplay = Schema.Struct({
  version: Schema.Literal(SESSION_PROTOCOL_VERSION),
  sessionId: SessionProtocolId,
  afterSequence: Sequence,
  events: Schema.Array(SessionEventEnvelope).pipe(Schema.maxItems(500)),
  snapshot: Schema.NullOr(SessionSnapshot)
})
export type SessionReplay = Schema.Schema.Type<typeof SessionReplay>

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

export type SessionReplayAdmission =
  | {
      readonly status: "accepted"
      readonly cursor: SessionEventCursor
      readonly events: ReadonlyArray<SessionEventEnvelope>
      readonly snapshot: SessionReplay["snapshot"]
    }
  | Exclude<SessionEventAdmission, { readonly status: "accepted" }>

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

/** Shared replay fence used by every local, direct, and relay client. */
export const admitSessionReplay = (
  cursor: SessionEventCursor,
  replay: SessionReplay
): SessionReplayAdmission => {
  let next = cursor
  if (replay.snapshot !== null) {
    if (replay.snapshot.sessionId !== replay.sessionId) {
      return { status: "sequence-conflict" }
    }
    if (replay.snapshot.throughSequence >= cursor.sequence) {
      next = {
        sequence: replay.snapshot.throughSequence,
        revision: replay.snapshot.revision,
        eventIds: []
      }
    }
  } else if (replay.afterSequence !== cursor.sequence) {
    return replay.afterSequence > cursor.sequence
      ? { status: "sequence-gap", expectedSequence: cursor.sequence + 1 }
      : { status: "sequence-conflict" }
  }

  const accepted: SessionEventEnvelope[] = []
  for (const envelope of replay.events) {
    if (envelope.sessionId !== replay.sessionId) return { status: "sequence-conflict" }
    const admission = admitSessionEvent(next, envelope)
    if (admission.status === "duplicate") continue
    if (admission.status !== "accepted") return admission
    next = admission.cursor
    accepted.push(envelope)
  }
  return { status: "accepted", cursor: next, events: accepted, snapshot: replay.snapshot }
}

export const isNextSessionEvent = (
  currentSequence: number,
  envelope: SessionEventEnvelope
): boolean => envelope.sequence === currentSequence + 1
