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
  it("retries a transient initial reconciliation without a focus change", async () => {
    vi.useFakeTimers()
    try {
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
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(mocks.snapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

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

  it("removes a connected running node missing from the authoritative snapshot", async () => {
    mocks.snapshot.mockResolvedValue(snapshot)
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Upsert",
      version: 2,
      eventId: "running",
      occurredAt: 10,
      node
    }]
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.nodes).toEqual([])
  })

  it("keeps completed output after its live tab disappears, even without a session file", async () => {
    mocks.snapshot.mockResolvedValue(snapshot)
    const completed = {
      ...node,
      status: "completed" as const,
      sessionFile: null,
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

  it("resolves a workflow selection to its first child when one exists", async () => {
    mocks.snapshot.mockResolvedValue(snapshot)
    const workflow: SubagentFleetNode = {
      ...node,
      id: "parent/wf-1",
      subagentId: "wf-1",
      runId: "wf-1",
      nodeKind: "workflow",
      agent: "workflow"
    }
    const child: SubagentFleetNode = {
      ...node,
      id: "parent/wf-1-step-1",
      subagentId: "wf-1-step-1",
      runId: "wf-1-step-1",
      parentId: workflow.id
    }
    const events: ReadonlyArray<SubagentFleetEvent> = [workflow, child].map((n, index) => ({
      _tag: "Upsert",
      version: 2,
      eventId: `upsert-${index}`,
      occurredAt: 30 + index,
      node: n
    }))
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    act(() => result.current.select(workflow.id))
    expect(result.current.selectedNode).toEqual(child)
  })

  it("resolves a childless workflow selection to the workflow itself, never null", async () => {
    // A null resolution silently rendered the MAIN conversation — a dead node
    // with no explanation. The workflow node itself renders a real panel.
    mocks.snapshot.mockResolvedValue(snapshot)
    const workflow: SubagentFleetNode = {
      ...node,
      id: "parent/wf-1",
      subagentId: "wf-1",
      runId: "wf-1",
      nodeKind: "workflow",
      agent: "workflow"
    }
    const events: ReadonlyArray<SubagentFleetEvent> = [{
      _tag: "Upsert",
      version: 2,
      eventId: "upsert-wf",
      occurredAt: 30,
      node: workflow
    }]
    const { result } = renderHook(() => useSubagentFleet({
      sessionId: "session-1",
      chatId: "chat-1",
      piSessionId: "parent",
      events
    }))

    act(() => result.current.select(workflow.id))
    expect(result.current.selectedNode).toEqual(workflow)
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
    expect(result.current.nodes).toEqual([])

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })
    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  })
})
