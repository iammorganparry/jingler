import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  SubagentFleetControlOutcome,
  SubagentFleetEvent,
  SubagentFleetSnapshot
} from "./subagent-fleet.js"

const node = {
  id: "parent/run-1/0",
  runId: "run-1",
  parentId: null,
  parentPiSessionId: "parent",
  agent: "scout",
  task: "Map the runtime",
  model: "anthropic/claude-test:low",
  status: "running",
  background: true,
  sessionFile: "/sessions/run-1/session.jsonl",
  currentTool: "workspace_read_file",
  startedAt: 1,
  updatedAt: 1,
  completedAt: null,
  usage: {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    costUsd: 0.01,
    durationMs: 200,
    toolCalls: 1
  },
  artifacts: [],
  attention: null
} as const

describe("subagent fleet contracts", () => {
  it("round-trips nested run snapshots with stable identities", () => {
    const snapshot = {
      version: 1,
      parentPiSessionId: "parent",
      generatedAt: 2,
      totalActive: 2,
      omitted: 0,
      activeCapacity: { used: 2, limit: 4 },
      nodes: [node, {
        ...node,
        id: "parent/run-1/0/run-2/0",
        runId: "run-2",
        parentId: node.id,
        agent: "reviewer",
        status: "needs-attention",
        attention: {
          requestId: "attention-1",
          reason: "need_decision",
          message: "Choose an API",
          requestedAt: 2
        }
      }]
    } as const

    expect(Schema.decodeUnknownSync(SubagentFleetSnapshot)(snapshot)).toEqual(
      snapshot
    )
    const event = Schema.decodeUnknownSync(SubagentFleetEvent)({
      _tag: "Snapshot",
      version: 1,
      eventId: "event-1",
      occurredAt: 2,
      snapshot
    })
    expect(event._tag).toBe("Snapshot")
    if (event._tag === "Snapshot") expect(event.snapshot.nodes).toHaveLength(2)
  })

  it("models factual acknowledged control outcomes", () => {
    expect(Schema.decodeUnknownSync(SubagentFleetControlOutcome)({
      version: 1,
      requestId: "request-1",
      runId: "run-1",
      action: "stop",
      acknowledged: true,
      status: "accepted",
      message: "Stop request delivered",
      acknowledgedAt: 3
    }).acknowledged).toBe(true)
  })

  it("rejects unsupported lifecycle state instead of guessing", () => {
    expect(() => Schema.decodeUnknownSync(SubagentFleetSnapshot)({
      version: 1,
      parentPiSessionId: "parent",
      generatedAt: 2,
      totalActive: 1,
      omitted: 0,
      activeCapacity: { used: 1, limit: 4 },
      nodes: [{ ...node, status: "probably-running" }]
    })).toThrow()
  })
})
