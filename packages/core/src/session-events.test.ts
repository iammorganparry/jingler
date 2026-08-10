import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  admitSessionEvent,
  isNextSessionEvent,
  SessionEventEnvelope
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

  it("validates canonical remote create, modify, delete, and rename evidence", () => {
    const changed = {
      ...envelope,
      event: {
        _tag: "DiffChanged",
        changes: {
          id: "changes-1",
          callId: "tool-1",
          changes: (["A", "M", "D", "R"] as const).map((status, index) => ({
            status,
            path: `src/${index}.ts`,
            oldPath: status === "R" ? "src/old.ts" : null,
            added: status === "D" ? 0 : 1,
            removed: status === "A" ? 0 : 1,
            binary: false,
            noNewlineAtEnd: false,
            beforeBytes: status === "A" ? 0 : 10,
            afterBytes: status === "D" ? 0 : 10,
            preview: null,
            patchArtifactId: `patch-${index}`
          })),
          totals: { added: 3, removed: 3 },
          authoritative: true,
          reconciledAt: "2026-08-10T12:00:00.000Z"
        }
      }
    }
    expect(Either.isRight(decode(SessionEventEnvelope, changed))).toBe(true)
    expect(Either.isLeft(decode(SessionEventEnvelope, {
      ...envelope,
      event: { _tag: "DiffChanged" }
    }))).toBe(true)
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

})
