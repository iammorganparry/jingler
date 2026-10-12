/** @vitest-environment jsdom */
import type { ImportableSession } from "@jingler/core"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useImportSessions } from "./use-import-sessions.js"

const make = (nativeSessionId: string, alreadyImported = false): ImportableSession => ({
  source: "claude-code",
  nativeSessionId,
  harness: "claude",
  cwd: "/dev/jingler",
  title: `Session ${nativeSessionId}`,
  updatedAt: "2026-10-01T10:00:00.000Z",
  messageCount: 2,
  folderExists: true,
  alreadyImported
})

// Mock RPC
vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsScanImportable: vi.fn(async () => [make("a"), make("b")]),
    sessionsImport: vi.fn(async () => ({ id: "imported" }))
  }
}))

afterEach(cleanup)

describe("useImportSessions", () => {
  it("starts in loading state", () => {
    const { result } = renderHook(() => useImportSessions())
    expect(result.current.status).toBe("loading")
    expect(result.current.candidates).toEqual([])
  })

  it("loads candidates", async () => {
    const { result } = renderHook(() => useImportSessions())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.candidates.length).toBe(2)
  })

  it("updates query", async () => {
    const { result } = renderHook(() => useImportSessions())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.onQueryChange("test"))
    expect(result.current.query).toBe("test")
  })
})
