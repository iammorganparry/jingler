// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DebugViewSnapshot } from "@jingler/core"

const invoke = vi.hoisted(() => vi.fn())
// oxlint-disable-next-line anti-slop/no-module-mocking -- The hook closes over the renderer bridge singleton; this test supplies its exact invoke contract.
vi.mock("./plugin-bridge.js", () => ({ pluginBridge: () => ({ invoke }) }))

import { useDebugSessionModel, useDebugSessions } from "./debug-session.js"

const inactive: DebugViewSnapshot = {
  active: false, session: null, scopes: [], variables: {}, actions: [], error: null
}

const stopped: DebugViewSnapshot = {
  active: true,
  session: {
    id: "dap-1", adapter: "fake", cwd: "/repo", status: "stopped",
    frame: { id: 10, name: "main", source: { path: "/repo/main.ts" }, line: 4, column: 1 },
    threads: [], stackFrames: [], breakpoints: {}, output: ""
  },
  scopes: [], variables: {}, actions: [], error: null
}

afterEach(() => {
  invoke.mockReset()
  vi.useRealTimers()
})

describe("debug session bridge", () => {
  it("polls enabled sessions and remains inert when disabled", async () => {
    invoke.mockResolvedValue(stopped)
    const enabled = renderHook(() => useDebugSessions(["session-1"], ["session-1"], true))
    await waitFor(() => expect(enabled.result.current["session-1"]?.session?.status).toBe("stopped"))
    expect(invoke).toHaveBeenCalledWith("debug.snapshot", { sessionId: "session-1" })
    enabled.unmount()
    invoke.mockClear()
    const disabled = renderHook(() => useDebugSessions(["session-1"], ["session-1"], false))
    await act(async () => undefined)
    expect(disabled.result.current).toEqual({})
    expect(invoke).not.toHaveBeenCalled()
  })

  it("polls visible sessions and keeps polling active debuggers when hidden", async () => {
    vi.useFakeTimers()
    invoke.mockResolvedValue(stopped)
    const hook = renderHook(
      ({ visible }) => useDebugSessions(["active", "stored"], visible, true),
      { initialProps: { visible: ["active"] } }
    )
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(invoke).toHaveBeenCalledWith("debug.snapshot", { sessionId: "active" })
    expect(invoke).not.toHaveBeenCalledWith("debug.snapshot", { sessionId: "stored" })

    invoke.mockClear()
    hook.rerender({ visible: [] })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(invoke).toHaveBeenCalledWith("debug.snapshot", { sessionId: "active" })
    expect(invoke).not.toHaveBeenCalledWith("debug.snapshot", { sessionId: "stored" })
    hook.unmount()
    vi.useRealTimers()
  })

  it("stops polling inactive sessions until activity changes", async () => {
    vi.useFakeTimers()
    invoke.mockResolvedValue(inactive)
    const hook = renderHook(
      ({ wakeKey }) => useDebugSessions(["session-1"], ["session-1"], true, wakeKey),
      { initialProps: { wakeKey: "thinking" } }
    )
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(invoke).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(1_400))
    expect(invoke).toHaveBeenCalledTimes(1)

    hook.rerender({ wakeKey: "debug.dap" })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(invoke).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

})

describe("debug session model", () => {
  it("routes controls and hover evaluation through the selected session", async () => {
    invoke.mockResolvedValue({ result: "4", type: "number" })
    const { result } = renderHook(() => useDebugSessionModel("session-1", stopped))
    await act(() => result.current.control("continue"))
    await act(() => result.current.hover({ expression: "count", frameId: 10 }))
    expect(invoke).toHaveBeenNthCalledWith(1, "debug.control", { sessionId: "session-1", action: "continue" })
    expect(invoke).toHaveBeenNthCalledWith(2, "debug.hover", { sessionId: "session-1", expression: "count", frameId: 10 })
  })
})
