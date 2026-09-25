// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import type { SubagentFleetEvent, SubagentFleetNode } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearSubagentTabs,
  completedSubagentNodes,
  publishActorSubagentTabs,
  publishSubagentTabs,
  releaseSubagentTabController,
  retainSubagentTabController,
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
  parentRuntimeSessionId: "parent",
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

  it("keeps controller state until every mounted chat surface releases it", () => {
    const { result } = renderHook(() => useSessionSubagentTabs("session-1"))
    act(() => {
      retainSubagentTabController("session-1", "chat-1")
      retainSubagentTabController("session-1", "chat-1")
      publishSubagentTabs("session-1", {
        chatId: "chat-1",
        active: [node()],
        completed: [],
        selectedId: "parent/worker-1"
      })
    })

    act(() => releaseSubagentTabController("session-1", "chat-1"))
    expect(result.current[0]?.selectedId).toBe("parent/worker-1")

    act(() => releaseSubagentTabController("session-1", "chat-1"))
    expect(result.current).toEqual([])
  })

  it("keeps identical child ids isolated by parent chat", () => {
    const { result } = renderHook(() => useSessionSubagentTabs("session-1"))
    act(() => {
      publishSubagentTabs("session-1", {
        chatId: "chat-a",
        active: [node({ task: "Agent A child" })],
        completed: [],
        selectedId: "parent/worker-1"
      })
      publishSubagentTabs("session-1", {
        chatId: "chat-b",
        active: [node({ task: "Agent B child" })],
        completed: [],
        selectedId: "main"
      })
    })

    expect(result.current.find(({ chatId }) => chatId === "chat-a")?.active[0]?.task)
      .toBe("Agent A child")
    expect(result.current.find(({ chatId }) => chatId === "chat-b")?.active[0]?.task)
      .toBe("Agent B child")
    expect(result.current.find(({ chatId }) => chatId === "chat-a")?.selectedId)
      .toBe("parent/worker-1")
    expect(result.current.find(({ chatId }) => chatId === "chat-b")?.selectedId)
      .toBe("main")
  })

  it("keeps the newest eight completions regardless of event order", () => {
    const events: ReadonlyArray<SubagentFleetEvent> = [100, 1, 2, 3, 4, 5, 6, 7, 8]
      .map((completedAt) => {
        const completed = node({
          id: `parent/worker-${completedAt}`,
          subagentId: `worker-${completedAt}`,
          orchestrationRunId: `worker-${completedAt}`,
          runId: `worker-${completedAt}`,
          status: "completed",
          updatedAt: completedAt,
          completedAt,
          terminal: { reason: "completed", summary: "Done", at: completedAt, retryable: false }
        })
        return {
          _tag: "Upsert" as const,
          version: 2 as const,
          eventId: `completed-${completedAt}`,
          occurredAt: completedAt,
          node: completed
        }
      })

    expect(completedSubagentNodes(events).map(({ completedAt }) => completedAt))
      .toEqual([100, 8, 7, 6, 5, 4, 3, 2])
  })

  it("keeps completed history when a tombstone rejects a delayed running event", () => {
    const completed = node({
      status: "completed",
      registryRevision: 10,
      updatedAt: 10,
      completedAt: 10,
      terminal: { reason: "completed", summary: "Done", at: 10, retryable: false }
    })
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Upsert",
      version: 2,
      eventId: "completed",
      occurredAt: 10,
      node: completed
    }, {
      _tag: "Remove",
      version: 2,
      eventId: "removed",
      occurredAt: 20,
      registryRevision: 20,
      id: completed.id
    }, {
      _tag: "Upsert",
      version: 2,
      eventId: "delayed-running",
      occurredAt: 15,
      node: node({ registryRevision: 15, updatedAt: 15 })
    }]

    expect(completedSubagentNodes(events)).toEqual([completed])
    expect(completedSubagentNodes([events[1]!, events[0]!, events[2]!])).toEqual([completed])
  })

  it("includes terminal nodes delivered only by a snapshot", () => {
    const completed = node({
      status: "completed",
      completedAt: 20,
      updatedAt: 20,
      terminal: { reason: "completed", summary: "Done", at: 20, retryable: false }
    })
    const event: SubagentFleetEvent = {
      _tag: "Snapshot",
      version: 2,
      eventId: "snapshot",
      occurredAt: 20,
      snapshot: {
        version: 2,
        parentRuntimeSessionId: "parent",
        registryRevision: 20,
        generatedAt: 20,
        totalActive: 0,
        omitted: 0,
        activeCapacity: { used: 0, limit: 8 },
        nodes: [completed]
      }
    }

    expect(completedSubagentNodes([event])).toEqual([completed])
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
      _tag: "Upsert",
      version: 2,
      eventId: "unknown",
      occurredAt: 2,
      node: unknown
    }]

    expect(completedSubagentNodes(events)).toEqual([unknown])
  })
})
