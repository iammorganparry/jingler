// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import type { SubagentFleetEvent, SubagentFleetNode } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearSubagentTabs,
  completedSubagentNodes,
  mergeCompletedSubagentNodes,
  publishActorSubagentTabs,
  publishSubagentTabs,
  releaseSubagentTabController,
  useSessionSubagentTabs
} from "./subagent-tab-store.js"

const node = (over: Partial<SubagentFleetNode> = {}): SubagentFleetNode => ({
  id: "parent/worker-1",
  subagentId: "worker-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "worker-1",
  parentId: null,
  parentPiSessionId: "parent",
  agent: "worker",
  task: "Implement tabs",
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: false,
  sessionFile: null,
  currentTool: null,
  startedAt: 1,
  updatedAt: 1,
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
  attention: null,
  ...over
})

afterEach(() => {
  cleanup()
  clearSubagentTabs("session-1")
})

describe("subagent tab store", () => {
  it("falls back to persistent actor tabs when the conversation controller unmounts", () => {
    const worker = node()
    const { result } = renderHook(() => useSessionSubagentTabs("session-1"))
    act(() => publishActorSubagentTabs("session-1", {
      chatId: "chat-1",
      active: [worker],
      completed: [],
      selectedId: "main"
    }))
    expect(result.current[0]?.active).toEqual([worker])

    act(() => publishSubagentTabs("session-1", {
      chatId: "chat-1",
      active: [],
      completed: [],
      selectedId: "main"
    }))
    expect(result.current[0]?.active).toEqual([])

    act(() => releaseSubagentTabController("session-1", "chat-1"))
    expect(result.current[0]?.active).toEqual([worker])
  })

  it("retains an unknown child's partial output in completed history", () => {
    const unknown = node({
      status: "unknown",
      health: "disconnected",
      terminal: {
        reason: "unknown",
        summary: "Child process ended before completion.",
        at: 2,
        retryable: false
      }
    })
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Snapshot",
      version: 2,
      eventId: "unknown-snapshot",
      occurredAt: 2,
      snapshot: {
        version: 2,
        parentPiSessionId: "parent",
        registryRevision: 2,
        generatedAt: 2,
        totalActive: 0,
        omitted: 0,
        activeCapacity: { used: 0, limit: 8 },
        nodes: [unknown]
      }
    }]

    expect(completedSubagentNodes(events)).toEqual([unknown])
  })

  it("deduplicates completed history when a run receives its canonical parent id", () => {
    const provisional = node({ id: "session-1:chat-1/worker-1", updatedAt: 2 })
    const canonical = node({ id: "parent/worker-1", updatedAt: 3 })

    expect(mergeCompletedSubagentNodes([provisional], [canonical])).toEqual([canonical])
  })

  it("does not retain a terminal Upsert when the authoritative snapshot is active", () => {
    const completed = node({ status: "completed", updatedAt: 2, completedAt: 2 })
    const running = node({ registryRevision: 3, updatedAt: 3 })
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Upsert",
      version: 2,
      eventId: "completed",
      occurredAt: 2,
      node: completed
    }, {
      _tag: "Snapshot",
      version: 2,
      eventId: "active-snapshot",
      occurredAt: 3,
      snapshot: {
        version: 2,
        parentPiSessionId: "parent",
        registryRevision: 3,
        generatedAt: 3,
        totalActive: 1,
        omitted: 0,
        activeCapacity: { used: 1, limit: 8 },
        nodes: [running]
      }
    }]

    expect(completedSubagentNodes(events)).toEqual([])
  })
})
