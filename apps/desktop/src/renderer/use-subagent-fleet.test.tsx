// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import type { SubagentFleetEvent, SubagentFleetNode, SubagentFleetSnapshot } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useSubagentFleet } from "./use-subagent-fleet.js"

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn()
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    agentSubagentFleetSnapshot: mocks.snapshot
  }
}))

const node: SubagentFleetNode = {
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 10,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentPiSessionId: "parent",
  agent: "worker",
  task: "Review polling",
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
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

const snapshot: SubagentFleetSnapshot = {
  version: 2,
  parentPiSessionId: "parent",
  registryRevision: 20,
  generatedAt: 20,
  totalActive: 0,
  omitted: 0,
  activeCapacity: { used: 0, limit: 8 },
  nodes: []
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mocks.snapshot.mockReset()
})

describe("useSubagentFleet reconciliation", () => {
  it("retries on focus after the Pi runtime is not active yet", async () => {
    mocks.snapshot
      .mockRejectedValueOnce(new Error("Pi session is not active"))
      .mockResolvedValue(snapshot)

    const events: ReadonlyArray<SubagentFleetEvent> = []
    renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })
    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  })

  it("removes a completed canonical durable node on focus through a session-file alias", async () => {
    const durableNode: SubagentFleetNode = {
      ...node,
      id: "parent/run-1",
      health: "unknown"
    }
    mocks.snapshot
      .mockResolvedValueOnce({
        ...snapshot,
        totalActive: 1,
        activeCapacity: { used: 1, limit: 8 },
        nodes: [durableNode]
      })
      .mockResolvedValue(snapshot)
    const events: ReadonlyArray<SubagentFleetEvent> = []
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "/sessions/parent.jsonl",
      events
    }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.nodes.map(({ id }) => id)).toStrictEqual([durableNode.id])
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.nodes).toStrictEqual([])
  })

  it("keeps completed transcript links after active Fleet chrome disappears", async () => {
    mocks.snapshot.mockResolvedValue(snapshot)
    const completed = {
      ...node,
      status: "completed" as const,
      sessionFile: "/sessions/child.jsonl",
      completedAt: 30,
      updatedAt: 30,
      terminal: {
        reason: "completed" as const,
        summary: "Done",
        at: 30,
        retryable: false
      }
    }
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Upsert",
      version: 2,
      eventId: "complete",
      occurredAt: 30,
      node: completed
    }, {
      _tag: "Remove",
      version: 2,
      eventId: "remove",
      occurredAt: 31,
      registryRevision: 31,
      id: completed.id
    }]
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    expect(result.current.nodes).toEqual([])
    expect(result.current.completedNodes).toEqual([completed])
    act(() => result.current.select(completed.id))
    expect(result.current.selectedNode).toEqual(completed)
  })

  it("does not restart or overlap reconciliation when events change", async () => {
    const pending = deferred<SubagentFleetSnapshot>()
    const nextPending = deferred<SubagentFleetSnapshot>()
    mocks.snapshot
      .mockReturnValueOnce(pending.promise)
      .mockReturnValue(nextPending.promise)
    const { rerender, result } = renderHook(
      ({ events }: { events: ReadonlyArray<SubagentFleetEvent> }) => useSubagentFleet({
        sessionId: "session-1",
        chatId: "chat-1",
        piSessionId: "parent",
        events
      }),
      { initialProps: { events: [] as ReadonlyArray<SubagentFleetEvent> } }
    )

    expect(mocks.snapshot).toHaveBeenCalledTimes(1)
    rerender({ events: [{
      _tag: "Upsert",
      version: 2,
      eventId: "upsert-1",
      occurredAt: 10,
      node
    }] })
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("focus"))
    expect(mocks.snapshot).toHaveBeenCalledTimes(1)

    await act(async () => pending.resolve(snapshot))
    expect(result.current.nodes.map(({ id }) => id)).toEqual([node.id])

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })
    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  })
})
