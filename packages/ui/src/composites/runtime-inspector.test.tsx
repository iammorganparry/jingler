import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { CURRENT_RUNTIME_CONTRACTS, type RuntimeDiagnosticSnapshot } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RuntimeInspector } from "./runtime-inspector.js"

afterEach(cleanup)

const snapshot: RuntimeDiagnosticSnapshot = {
  runId: "run-1",
  sessionId: "session-1",
  connectionId: "connection-1",
  authRoute: "claude-setup-token",
  accountFingerprint: "account-a1b2",
  versions: CURRENT_RUNTIME_CONTRACTS,
  promptHash: "prompt-hash",
  promptSections: [],
  activeToolIds: ["workspace.read"],
  mode: "ask",
  retries: 0,
  mutations: [],
  fileChangeStatuses: ["A", "M"],
  mcpHealth: [],
  terminalCause: "done",
  updatedAt: "2026-08-10T00:00:00.000Z"
}

describe("RuntimeInspector", () => {
  it("shows contract metadata and invokes refresh/export actions", () => {
    const onRefresh = vi.fn()
    const onExport = vi.fn()
    render(<RuntimeInspector snapshot={snapshot} loading={false} onRefresh={onRefresh} onExport={onExport} />)
    expect(screen.getByText("prompt-hash")).toBeDefined()
    expect(screen.getByText("workspace.read")).toBeDefined()
    expect(screen.getByText("A, M")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }))
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onExport).toHaveBeenCalledOnce()
  })
})
