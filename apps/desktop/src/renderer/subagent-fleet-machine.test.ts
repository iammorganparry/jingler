import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import type { SubagentFleetNode } from "@jingler/core"
import { subagentFleetMachine } from "./subagent-fleet-machine.js"

const node: SubagentFleetNode = {
  id: "parent/run-1",
  runId: "run-1",
  parentId: null,
  parentPiSessionId: "parent",
  agent: "worker",
  task: "Implement the drawer",
  model: null,
  status: "running",
  background: true,
  sessionFile: null,
  currentTool: null,
  startedAt: 10,
  updatedAt: 10,
  completedAt: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolCalls: 0
  },
  artifacts: [],
  attention: null
}

describe("subagentFleetMachine", () => {
  it("projects lifecycle events and falls back to Main when a selected child disappears", () => {
    const actor = createActor(subagentFleetMachine, {
      input: { parentPiSessionId: "fallback" }
    }).start()
    actor.send({
      type: "SYNC",
      events: [{
        _tag: "Upsert",
        version: 1,
        eventId: "start-1",
        occurredAt: 10,
        node
      }]
    })
    actor.send({ type: "SELECT", id: node.id })
    expect(actor.getSnapshot().context.selectedId).toBe(node.id)
    expect(actor.getSnapshot().context.tree.parentPiSessionId).toBe("parent")

    actor.send({
      type: "SYNC",
      events: [{
        _tag: "Remove",
        version: 1,
        eventId: "remove-1",
        occurredAt: 20,
        id: node.id
      }]
    })
    expect(actor.getSnapshot().context.selectedId).toBe("main")
    actor.stop()
  })

  it("bounds resize and tracks acknowledged control outcomes", () => {
    const actor = createActor(subagentFleetMachine, {
      input: { parentPiSessionId: "parent" }
    }).start()
    actor.send({ type: "RESIZE", height: 900 })
    actor.send({ type: "CONTROL_STARTED", requestId: "request-1" })
    expect(actor.getSnapshot().context.height).toBe(420)
    expect(actor.getSnapshot().context.pendingRequestId).toBe("request-1")
    actor.send({
      type: "CONTROL_SETTLED",
      outcome: {
        version: 1,
        requestId: "request-1",
        runId: "run-1",
        action: "stop",
        acknowledged: true,
        status: "accepted",
        message: "stopped",
        acknowledgedAt: 30
      }
    })
    expect(actor.getSnapshot().context.lastOutcome?.message).toBe("stopped")
    expect(actor.getSnapshot().context.pendingRequestId).toBeNull()
    actor.stop()
  })
})
