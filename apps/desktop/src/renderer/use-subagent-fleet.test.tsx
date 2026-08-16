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
  runId: "run-1",
  parentId: null,
  parentPiSessionId: "parent",
  agent: "worker",
  task: "Review polling",
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

const snapshot: SubagentFleetSnapshot = {
  version: 1,
  parentPiSessionId: "parent",
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

describe("useSubagentFleet polling", () => {
  it("retries after the Pi runtime is not active yet", async () => {
    let poll: (() => void) | null = null
    vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") poll = () => handler()
      return 1
    }) as typeof window.setInterval)
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
      poll?.()
      await Promise.resolve()
    })
    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  })

  it("does not restart or overlap polling when events change", async () => {
    let poll: (() => void) | null = null
    const fakeSetInterval = ((handler: TimerHandler) => {
      if (typeof handler === "function") {
        poll = () => {
          handler()
        }
      }
      return 1
    }) as typeof window.setInterval
    vi.spyOn(window, "setInterval").mockImplementation(fakeSetInterval)
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
      {
        initialProps: {
          events: [] as ReadonlyArray<SubagentFleetEvent>
        }
      }
    )

    expect(mocks.snapshot).toHaveBeenCalledTimes(1)
    const upsert: SubagentFleetEvent = {
      _tag: "Upsert",
      version: 1,
      eventId: "upsert-1",
      occurredAt: 10,
      node
    }
    rerender({ events: [upsert] })
    expect(mocks.snapshot).toHaveBeenCalledTimes(1)

    expect(poll).not.toBeNull()
    await act(async () => {
      poll?.()
      poll?.()
      poll?.()
      await Promise.resolve()
    })
    expect(mocks.snapshot).toHaveBeenCalledTimes(1)

    await act(async () => pending.resolve(snapshot))
    expect(result.current.nodes.map(({ id }) => id)).toEqual([node.id])

    await act(async () => {
      poll?.()
      await Promise.resolve()
    })
    expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  })
})
