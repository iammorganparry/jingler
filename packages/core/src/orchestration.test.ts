import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WorkerActivity } from "./orchestration.js"

const decode = Schema.decodeUnknownEither(WorkerActivity)

const worker = {
  sessionId: "session-1",
  planId: "plan-1",
  producingChatId: "chat-1",
  agentId: "worker-core",
  stageIds: ["01", "02"],
  harness: "codex",
  model: "gpt-5.6-sol",
  attempt: 1
}

describe("WorkerActivity decoding", () => {
  it.each([
    {
      name: "a reset snapshot",
      activity: {
        _tag: "Reset",
        sessionId: "session-1",
        planId: "plan-1",
        producingChatId: "chat-1",
        workers: [{ worker, status: "queued", message: null }]
      }
    },
    {
      name: "a lifecycle state",
      activity: {
        _tag: "State",
        worker,
        status: "running",
        message: null
      }
    },
    {
      name: "a normalized harness event",
      activity: {
        _tag: "HarnessEvent",
        worker,
        stageId: "01",
        event: {
          _tag: "ToolStart",
          id: "tool-1",
          name: "Read",
          target: "packages/core/src/orchestration.ts"
        }
      }
    }
  ])("decodes $name", ({ activity }) => {
    expect(Either.isRight(decode(activity))).toBe(true)
  })

  it("decodes an empty reset while retaining its plan scope", () => {
    const result = decode({
      _tag: "Reset",
      sessionId: "session-1",
      planId: "plan-1",
      producingChatId: "chat-1",
      workers: []
    })

    expect(Either.isRight(result)).toBe(true)
  })
})

describe("WorkerActivity rejection", () => {
  it.each([
    {
      name: "a reset without plan identity",
      activity: {
        _tag: "Reset",
        sessionId: "session-1",
        producingChatId: "chat-1",
        workers: []
      }
    },
    {
      name: "a state without worker identity",
      activity: {
        _tag: "State",
        status: "running",
        message: null
      }
    },
    {
      name: "an event whose worker has no plan identity",
      activity: {
        _tag: "HarnessEvent",
        worker: {
          sessionId: "session-1",
          producingChatId: "chat-1",
          agentId: "worker-core",
          stageIds: ["01"],
          harness: "codex",
          model: "gpt-5.6-sol",
          attempt: 1
        },
        stageId: "01",
        event: { _tag: "Assistant", text: "Working" }
      }
    }
  ])("rejects $name", ({ activity }) => {
    expect(Either.isLeft(decode(activity))).toBe(true)
  })

  it("rejects a malformed lifecycle status", () => {
    expect(
      Either.isLeft(
        decode({
          _tag: "State",
          worker,
          status: "starting",
          message: null
        })
      )
    ).toBe(true)
  })
})
