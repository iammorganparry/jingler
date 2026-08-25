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
