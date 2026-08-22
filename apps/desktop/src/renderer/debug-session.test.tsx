// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DebugViewSnapshot } from "@jingler/core"

const invoke = vi.hoisted(() => vi.fn())
// oxlint-disable-next-line anti-slop/no-module-mocking -- The hook closes over the renderer bridge singleton; this test supplies its exact invoke contract.
vi.mock("./plugin-bridge.js", () => ({ pluginBridge: () => ({ invoke }) }))

import { useDebugSessionModel, useDebugSessions } from "./debug-session.js"

const stopped: DebugViewSnapshot = {
  active: true,
  session: {
    id: "dap-1", adapter: "fake", cwd: "/repo", status: "stopped",
    frame: { id: 10, name: "main", source: { path: "/repo/main.ts" }, line: 4, column: 1 },
    threads: [], stackFrames: [], breakpoints: {}, output: ""
  },
  scopes: [], variables: {}, actions: [], error: null
}

afterEach(() => invoke.mockReset())

describe("debug session bridge", () => {
  it("polls enabled sessions and remains inert when disabled", async () => {
    invoke.mockResolvedValue(stopped)
    const enabled = renderHook(() => useDebugSessions(["session-1"], true))
    await waitFor(() => expect(enabled.result.current["session-1"]?.session?.status).toBe("stopped"))
    expect(invoke).toHaveBeenCalledWith("debug.snapshot", { sessionId: "session-1" })
    enabled.unmount()
    invoke.mockClear()
    const disabled = renderHook(() => useDebugSessions(["session-1"], false))
    await act(async () => undefined)
    expect(disabled.result.current).toEqual({})
    expect(invoke).not.toHaveBeenCalled()
  })

  it("routes controls and hover evaluation through the selected session", async () => {
    invoke.mockResolvedValue({ result: "4", type: "number" })
    const { result } = renderHook(() => useDebugSessionModel("session-1", stopped))
    await act(() => result.current.control("continue"))
    await act(() => result.current.hover({ expression: "count", frameId: 10 }))
    expect(invoke).toHaveBeenNthCalledWith(1, "debug.control", { sessionId: "session-1", action: "continue" })
    expect(invoke).toHaveBeenNthCalledWith(2, "debug.hover", { sessionId: "session-1", expression: "count", frameId: 10 })
  })
})
