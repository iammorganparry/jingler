import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import type { Subagent, SubagentFleetNode } from "@jingler/core"
import {
  projectLegacySubagents,
  subagentFleetMachine
} from "./subagent-fleet-machine.js"

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

  it("selects the newest parent and partitions retained history on rollover", () => {
    const actor = createActor(subagentFleetMachine, {
      input: { parentPiSessionId: "fallback" }
    }).start()
    const newer = {
      ...node,
      id: "new-parent/run-2",
      runId: "run-2",
      parentPiSessionId: "new-parent",
      updatedAt: 30
    }
    actor.send({
      type: "SYNC",
      events: [
        {
          _tag: "Upsert",
          version: 1,
          eventId: "old-parent",
          occurredAt: 10,
          node
        },
        {
          _tag: "Upsert",
          version: 1,
          eventId: "new-parent",
          occurredAt: 30,
          node: newer
        },
        {
          _tag: "Remove",
          version: 1,
          eventId: "late-old-remove",
          occurredAt: 40,
          id: node.id
        }
      ]
    })

    expect(actor.getSnapshot().context.tree.parentPiSessionId).toBe("new-parent")
    expect(actor.getSnapshot().context.tree.nodes.map(({ id }) => id))
      .toEqual([newer.id])
    expect(actor.getSnapshot().context.selectedId).toBe("main")
    actor.stop()
  })

  it("projects normalized agents and reviewer into the same Fleet hierarchy", () => {
    const message = {
      id: "message-1",
      role: "assistant",
      parts: [{ _tag: "Text", text: "Review complete" }],
      streaming: false,
      createdAt: "2026-08-10T00:00:00.000Z"
    } satisfies Subagent["message"]
    const parent: Subagent = {
      id: "legacy-parent",
      name: "Explore",
      description: "Inspect the renderer",
      parentId: null,
      status: "working",
      message
    }
    const reviewer: Subagent = {
      id: "reviewer",
      name: "Reviewer",
      description: "Review the worktree",
      parentId: "legacy-parent",
      status: "done",
      message: { ...message, id: "message-2" }
    }
    const actor = createActor(subagentFleetMachine, {
      input: { parentPiSessionId: "parent" }
    }).start()
    actor.send({
      type: "SYNC",
      events: projectLegacySubagents("parent", [parent, reviewer])
    })

    expect(actor.getSnapshot().context.tree.nodes).toEqual([
      expect.objectContaining({
        runId: "legacy:legacy-parent",
        agent: "Explore",
        status: "running",
        parentId: null
      }),
      expect.objectContaining({
        runId: "legacy:reviewer",
        agent: "Reviewer",
        status: "completed",
        parentId: "parent/legacy/legacy-parent"
      })
    ])
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
