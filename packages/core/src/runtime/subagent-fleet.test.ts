import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  SubagentFleetControlOutcome,
  SubagentFleetEvent,
  SubagentFleetSnapshot,
  SubagentSupervisorSnapshot,
  SubagentChildStateEvent,
  SubagentControlEnvelope,
  SubagentControlReceipt,
  SubagentAttentionRequest,
  SubagentAttentionReply
} from "./subagent-fleet.js"

const node = {
  id: "parent/run-1%3Astep%3A0",
  subagentId: "run-1:step:0",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "run-1:step:0",
  parentId: null,
  parentRuntimeSessionId: "parent",
  agent: "scout",
  task: "Map the runtime",
  model: "anthropic/claude-test:low",
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
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
      version: 2,
      parentRuntimeSessionId: "parent",
      registryRevision: 2,
      generatedAt: 2,
      totalActive: 2,
      omitted: 0,
      activeCapacity: { used: 2, limit: 4 },
      nodes: [node, {
        ...node,
        id: "parent/run-2%3Astep%3A0",
        subagentId: "run-2:step:0",
        orchestrationRunId: "run-1",
        runId: "run-2:step:0",
        parentId: node.id,
        agent: "reviewer",
        status: "needs-attention",
        attention: {
          requestId: "attention-1",
          reason: "need_decision",
          message: "Choose an API",
          requestedAt: 2,
          deadlineAt: null
        }
      }]
    } as const

    expect(Schema.decodeUnknownSync(SubagentFleetSnapshot)(snapshot)).toEqual(
      snapshot
    )
    const event = Schema.decodeUnknownSync(SubagentFleetEvent)({
      _tag: "Snapshot",
      version: 2,
      eventId: "event-1",
      occurredAt: 2,
      snapshot
    })
    expect(event._tag).toBe("Snapshot")
    if (event._tag === "Snapshot") expect(event.snapshot.nodes).toHaveLength(2)
  })

  it("models factual acknowledged control outcomes", () => {
    expect(Schema.decodeUnknownSync(SubagentFleetControlOutcome)({
      version: 2,
      requestId: "request-1",
      runId: "run-1",
      action: "stop",
      acknowledged: true,
      status: "accepted",
      deliveryStatus: "delivered",
      sequence: 1,
      nativeRequestId: "native-1",
      message: "Stop request delivered",
      acknowledgedAt: 3
    }).acknowledged).toBe(true)
  })

  it("rejects unsupported lifecycle state instead of guessing", () => {
    expect(() => Schema.decodeUnknownSync(SubagentFleetSnapshot)({
      version: 2,
      parentRuntimeSessionId: "parent",
      registryRevision: 2,
      generatedAt: 2,
      totalActive: 1,
      omitted: 0,
      activeCapacity: { used: 1, limit: 4 },
      nodes: [{ ...node, status: "probably-running" }]
    })).toThrow()
  })

  it("decodes the one supervision and bidirectional message contract", () => {
    expect(Schema.decodeUnknownSync(SubagentSupervisorSnapshot)({
      version: 2,
      parentRuntimeSessionId: "parent",
      registryRevision: 4,
      status: "running",
      goalRevision: 2,
      phase: "review",
      siblings: [{
        subagentId: "child-1",
        agent: "scout",
        task: "Inspect",
        status: "running",
        phase: null,
        outputAvailable: false
      }],
      generatedAt: 10
    }).registryRevision).toBe(4)
    expect(Schema.decodeUnknownSync(SubagentChildStateEvent)({
      version: 2,
      eventId: "event-2",
      parentRuntimeSessionId: "parent",
      subagentId: "child-1",
      orchestrationRunId: "run-1",
      childSequence: 3,
      occurredAt: 10,
      status: "running",
      health: "connected",
      phase: "inspect",
      currentTool: "workspace_read_file",
      blocking: null,
      terminal: null
    }).childSequence).toBe(3)
    const envelope = Schema.decodeUnknownSync(SubagentControlEnvelope)({
      version: 2,
      messageId: "control-1",
      idempotencyKey: "parent/control-1",
      parentRuntimeSessionId: "parent",
      subagentId: "child-1",
      orchestrationRunId: "run-1",
      sequence: 1,
      action: "steer",
      message: "Inspect tests",
      replyTo: null,
      createdAt: 10,
      deadlineAt: 20
    })
    expect(envelope.action).toBe("steer")
    expect(Schema.decodeUnknownSync(SubagentControlReceipt)({
      version: 2,
      messageId: envelope.messageId,
      parentRuntimeSessionId: "parent",
      subagentId: "child-1",
      sequence: 1,
      status: "delivered",
      occurredAt: 11,
      message: null
    }).status).toBe("delivered")
    const attention = Schema.decodeUnknownSync(SubagentAttentionRequest)({
      version: 2,
      requestId: "attention-1",
      parentRuntimeSessionId: "parent",
      subagentId: "child-1",
      orchestrationRunId: "run-1",
      reason: "need_decision",
      message: "Choose",
      createdAt: 12,
      deadlineAt: 20
    })
    expect(Schema.decodeUnknownSync(SubagentAttentionReply)({
      version: 2,
      requestId: attention.requestId,
      messageId: "reply-1",
      parentRuntimeSessionId: "parent",
      subagentId: "child-1",
      message: "Use the public API",
      createdAt: 13
    }).requestId).toBe(attention.requestId)
  })

  it("rejects the removed fleet protocol version", () => {
    expect(() => Schema.decodeUnknownSync(SubagentFleetSnapshot)({
      version: 1,
      parentRuntimeSessionId: "parent",
      registryRevision: 1,
      generatedAt: 1,
      totalActive: 0,
      omitted: 0,
      activeCapacity: { used: 0, limit: 4 },
      nodes: []
    })).toThrow()
  })

})
