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
    actor.send({ type: "INGEST", event: upsert("new", node("parent/run", 5, "completed")) })
    actor.send({ type: "INGEST", event: upsert("old", node("parent/run", 2)) })
    actor.send({ type: "INGEST", event: upsert("new", node("parent/run", 9, "failed")) })

    expect(actor.getSnapshot().context.nodes).toEqual([node("parent/run", 5, "completed")])
    actor.stop()
  })

  it("reconciles missing active work to unknown instead of reporting it live", () => {
    const actor = createSubagentRunTreeActor("parent").start()
    actor.send({ type: "INGEST", event: upsert("running", node("parent/run", 2)) })
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
      id: "parent/run",
      status: "unknown",
      completedAt: 4
    })
    actor.stop()
  })

  it("keeps nested identity while rejecting cycles and foreign snapshots", () => {
    const actor = createSubagentRunTreeActor("parent").start()
    actor.send({ type: "INGEST", event: upsert("root", node("parent/root", 1)) })
    actor.send({ type: "INGEST", event: upsert("child", node("parent/child", 2, "running", "parent/root")) })
    actor.send({ type: "INGEST", event: upsert("cycle", node("parent/root", 3, "running", "parent/child")) })
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
          totalActive: 2,
          omitted: 1,
          activeCapacity: { used: 2, limit: 4 },
          nodes: []
        }
      }
    })

    expect(actor.getSnapshot().context.totalActive).toBe(0)
    expect(actor.getSnapshot().context.nodes.map(({ id, parentId }) => ({ id, parentId })))
      .toEqual(expect.arrayContaining([
        { id: "parent/root", parentId: null },
        { id: "parent/child", parentId: "parent/root" }
      ]))
    expect(actor.getSnapshot().context.nodes).toHaveLength(2)
    actor.stop()
  })

  it("rejects foreign mutations and uses tombstones against stale resurrection", () => {
    const actor = createSubagentRunTreeActor("parent").start()
    actor.send({
      type: "INGEST",
      event: upsert("current", node("parent/run", 20))
    })
    actor.send({
      type: "INGEST",
      event: {
        _tag: "Remove",
        version: 1,
        eventId: "stale-remove",
        occurredAt: 10,
        id: "parent/run"
      }
    })
    actor.send({
      type: "INGEST",
      event: upsert("foreign-upsert", {
        ...node("other/run", 30),
        parentPiSessionId: "other"
      })
    })
    actor.send({
      type: "INGEST",
      event: {
        _tag: "Remove",
        version: 1,
        eventId: "foreign-remove",
        occurredAt: 30,
        id: "other/run"
      }
    })
    expect(actor.getSnapshot().context.nodes.map(({ id }) => id))
      .toEqual(["parent/run"])

    actor.send({
      type: "INGEST",
      event: {
        _tag: "Remove",
        version: 1,
        eventId: "current-remove",
        occurredAt: 40,
        id: "parent/run"
      }
    })
    actor.send({
      type: "INGEST",
      event: upsert("stale-resurrection", node("parent/run", 35))
    })
    expect(actor.getSnapshot().context.nodes).toEqual([])
    actor.stop()
  })
})
