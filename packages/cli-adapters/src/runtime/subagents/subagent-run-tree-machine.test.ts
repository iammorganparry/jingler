import type {
  SubagentFleetEvent,
  SubagentFleetNode
} from "@jingler/core"
import { describe, expect, it } from "vitest"
import { createSubagentRunTreeActor } from "./subagent-run-tree-machine.js"

const node = (
  id: string,
  updatedAt: number,
  status: SubagentFleetNode["status"] = "running",
  parentId: string | null = null
): SubagentFleetNode => ({
  id,
  runId: id,
  parentId,
  parentPiSessionId: "parent",
  agent: "scout",
  task: "Inspect",
  model: "anthropic/claude-test:low",
  status,
  background: true,
  sessionFile: null,
  currentTool: null,
  startedAt: 1,
  updatedAt,
  completedAt: status === "running" ? null : updatedAt,
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
})

const upsert = (
  eventId: string,
  value: SubagentFleetNode
): SubagentFleetEvent => ({
  _tag: "Upsert",
  version: 1,
  eventId,
  occurredAt: value.updatedAt,
  node: value
})

describe("subagent run tree machine", () => {
  it("deduplicates and ignores reordered stale updates", () => {
    const actor = createSubagentRunTreeActor("parent").start()
    actor.send({ type: "INGEST", event: upsert("new", node("run", 5, "completed")) })
    actor.send({ type: "INGEST", event: upsert("old", node("run", 2)) })
    actor.send({ type: "INGEST", event: upsert("new", node("run", 9, "failed")) })

    expect(actor.getSnapshot().context.nodes).toEqual([node("run", 5, "completed")])
    actor.stop()
  })

  it("reconciles missing active work to unknown instead of reporting it live", () => {
    const actor = createSubagentRunTreeActor("parent").start()
    actor.send({ type: "INGEST", event: upsert("running", node("run", 2)) })
    actor.send({
      type: "INGEST",
      event: {
        _tag: "Snapshot",
        version: 1,
        eventId: "snapshot",
        occurredAt: 4,
        snapshot: {
          version: 1,
          parentPiSessionId: "parent",
          generatedAt: 4,
          totalActive: 0,
          omitted: 0,
          activeCapacity: { used: 0, limit: 4 },
          nodes: []
        }
      }
    })

    expect(actor.getSnapshot().context.nodes[0]).toMatchObject({
      id: "run",
      status: "unknown",
      completedAt: 4
    })
    actor.stop()
  })

  it("keeps nested identity while rejecting cycles and foreign snapshots", () => {
    const actor = createSubagentRunTreeActor("parent").start()
    actor.send({ type: "INGEST", event: upsert("root", node("root", 1)) })
    actor.send({ type: "INGEST", event: upsert("child", node("child", 2, "running", "root")) })
    actor.send({ type: "INGEST", event: upsert("cycle", node("root", 3, "running", "child")) })
    actor.send({
      type: "INGEST",
      event: {
        _tag: "Snapshot",
        version: 1,
        eventId: "foreign",
        occurredAt: 4,
        snapshot: {
          version: 1,
          parentPiSessionId: "other",
          generatedAt: 4,
          totalActive: 0,
          omitted: 0,
          activeCapacity: { used: 0, limit: 4 },
          nodes: []
        }
      }
    })

    expect(actor.getSnapshot().context.nodes.map(({ id, parentId }) => ({ id, parentId })))
      .toEqual(expect.arrayContaining([
        { id: "root", parentId: null },
        { id: "child", parentId: "root" }
      ]))
    expect(actor.getSnapshot().context.nodes).toHaveLength(2)
    actor.stop()
  })
})
