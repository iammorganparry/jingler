import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  admitSessionEvent,
  isNextSessionEvent,
  SessionCommand,
  SessionEventEnvelope,
  SessionReplay
} from "./session-events.js"

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema)(value, { onExcessProperty: "error" })

const envelope = {
  version: 1,
  eventId: "event_abcdefghijklmnop",
  sessionId: "session_abcdefghijklmnop",
  sequence: 1,
  revision: 0,
  occurredAt: 1_700_000_000,
  event: {
    _tag: "Stream",
    event: { _tag: "Assistant", text: "Hello" }
  }
} as const

describe("shared session protocol", () => {
  it("validates versioned session commands", () => {
    expect(
      Either.isRight(
        decode(SessionCommand, {
          version: 1,
          commandId: "command_abcdefghijklmnop",
          sessionId: "session_abcdefghijklmnop",
          expectedRevision: 0,
          controllerGeneration: 1,
          command: { _tag: "Prompt", text: "Continue", attachments: [] }
        })
      )
    ).toBe(true)
    expect(
      Either.isLeft(
        decode(SessionCommand, {
          version: 2,
          commandId: "command_abcdefghijklmnop",
          sessionId: "session_abcdefghijklmnop",
          expectedRevision: 0,
          controllerGeneration: 1,
          command: { _tag: "Cancel" }
        })
      )
    ).toBe(true)
  })

  it("validates every session event envelope field", () => {
    expect(Either.isRight(decode(SessionEventEnvelope, envelope))).toBe(true)
    expect(
      Either.isLeft(decode(SessionEventEnvelope, { ...envelope, sequence: 0 }))
    ).toBe(true)
    expect(
      Either.isLeft(decode(SessionEventEnvelope, { ...envelope, revision: -1 }))
    ).toBe(true)
    expect(
      Either.isLeft(decode(SessionEventEnvelope, { ...envelope, eventId: "x" }))
    ).toBe(true)
  })

  it("recognizes only the next monotonic event", () => {
    expect(isNextSessionEvent(0, envelope)).toBe(true)
    expect(isNextSessionEvent(1, envelope)).toBe(false)
  })

  it("admits ordered events idempotently", () => {
    const initial = { sequence: 0, revision: 0, eventIds: [] }
    const accepted = admitSessionEvent(initial, envelope)
    expect(accepted.status).toBe("accepted")
    if (accepted.status !== "accepted") throw new Error("event was not accepted")
    expect(admitSessionEvent(accepted.cursor, envelope)).toEqual({
      status: "duplicate"
    })
    expect(
      admitSessionEvent(accepted.cursor, {
        ...envelope,
        eventId: "event_qrstuvwxyzabcdef",
        sequence: 3
      })
    ).toEqual({ status: "sequence-gap", expectedSequence: 2 })
  })

  it("validates cursor replay and snapshot fallback", () => {
    const replay = {
      version: 1,
      sessionId: envelope.sessionId,
      afterSequence: 0,
      events: [envelope],
      snapshot: null
    }
    expect(Either.isRight(decode(SessionReplay, replay))).toBe(true)
    expect(
      Either.isLeft(
        decode(SessionReplay, {
          ...replay,
          events: Array.from({ length: 501 }, () => envelope)
        })
      )
    ).toBe(true)
  })
})
