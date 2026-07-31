import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  activePlanParticipants,
  parsePlanThreadReply,
  PlanMentionDelivery,
  PlanParticipant,
  planThreadRelayPrompt,
  WorkerActivity
} from "./orchestration.js"

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
        mode: "replace",
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
      mode: "replace",
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
        mode: "replace",
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

  it("rejects a reset without explicit replace or patch semantics", () => {
    expect(
      Either.isLeft(
        decode({
          _tag: "Reset",
          sessionId: "session-1",
          planId: "plan-1",
          producingChatId: "chat-1",
          workers: []
        })
      )
    ).toBe(true)
  })
})

describe("plan-thread participants", () => {
  const orchestrator = {
    routingId: "orchestrator:chat-1",
    displayName: "Orchestrator",
    role: "orchestrator",
    lifecycle: "parked",
    ownerRoutingId: null
  } as const
  const workerParticipant = {
    routingId: "worker:plan-1:worker-core:2",
    displayName: "worker-core",
    role: "worker",
    lifecycle: "running",
    ownerRoutingId: null
  } as const

  it("decodes provider-neutral participants and per-target delivery outcomes", () => {
    expect(
      Either.isRight(Schema.decodeUnknownEither(PlanParticipant)(orchestrator))
    ).toBe(true)
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(PlanMentionDelivery)({
          participantId: workerParticipant.routingId,
          status: "unavailable",
          detail: "The worker settled before delivery.",
          retryable: true
        })
      )
    ).toBe(true)
  })

  it("keeps active identities once and preserves deterministic source order", () => {
    expect(
      activePlanParticipants([
        [orchestrator, workerParticipant],
        [orchestrator, workerParticipant]
      ])
    ).toEqual([orchestrator, workerParticipant])
  })

  it("extracts agent-to-agent mentions and gives nested agents relay context", () => {
    const parsed = parsePlanThreadReply(
      `Please ask the worker.\n[[mention:${workerParticipant.routingId}]]\n[[mention:${workerParticipant.routingId}]]`
    )
    expect(parsed).toEqual({
      body: "Please ask the worker.",
      mentionedParticipantIds: [workerParticipant.routingId]
    })
    expect(
      planThreadRelayPrompt({
        annotationId: "annotation-1",
        target: {
          routingId: "subagent:orchestrator:chat-1:task-1",
          displayName: "Explore",
          role: "subagent",
          lifecycle: "running",
          ownerRoutingId: orchestrator.routingId
        },
        body: "Check the parser.",
        availableParticipants: [orchestrator, workerParticipant]
      })
    ).toContain("Relay this message to the active nested agent")
  })
})
