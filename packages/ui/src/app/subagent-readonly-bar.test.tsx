import type { SubagentFleetNode } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SubagentReadOnlyBar } from "./subagent-readonly-bar.js"

const node = (over: Partial<SubagentFleetNode> = {}): SubagentFleetNode => ({
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentRuntimeSessionId: "parent",
  agent: "scout",
  task: "Map the UI",
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: false,
  sessionFile: null,
  currentTool: null,
  startedAt: 1_000,
  updatedAt: 2_000,
  completedAt: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
  artifacts: [],
  attention: null,
  workspace: null,
  prNumber: null,
  ...over
})

const renderBar = (n: SubagentFleetNode, over: Partial<Parameters<typeof SubagentReadOnlyBar>[0]> = {}) => {
  const props = {
    node: n,
    mainTitle: "Survey the app",
    onStop: vi.fn(() => Promise.resolve({ acknowledged: true })),
    onReply: vi.fn(),
    onRetry: vi.fn(),
    ...over
  }
  render(<SubagentReadOnlyBar {...props} />)
  return props
}

afterEach(cleanup)

describe("SubagentReadOnlyBar", () => {
  it("running: read-only line with Stop, which goes pending", async () => {
    const props = renderBar(node())
    expect(screen.getByTestId("subagent-readonly-bar").textContent).toContain("Subagent of Survey the app · read-only")
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(props.onStop).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByTestId("subagent-readonly-bar").textContent).toContain("Stopping scout…"))
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("running: an unacknowledged stop re-enables Stop", async () => {
    renderBar(node(), { onStop: () => Promise.resolve({ acknowledged: false }) })
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() => expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId("subagent-readonly-bar").textContent).toContain("read-only")
  })

  it("stopped: shows the stopped line with elapsed time and no Stop", () => {
    renderBar(
      node({
        status: "stopped",
        startedAt: 0,
        terminal: { reason: "stopped", summary: "Parent stopped", at: 130_000, retryable: false }
      })
    )
    expect(screen.getByTestId("subagent-readonly-bar").textContent).toBe("Stopped by you · 2m 10s")
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
  })

  it("attention: shows the message and Reply sends the text to the child", () => {
    const props = renderBar(
      node({
        status: "needs-attention",
        attention: { requestId: "r1", reason: "need_decision", message: "Include a11y?", requestedAt: 5, deadlineAt: null }
      })
    )
    expect(screen.getByTestId("subagent-readonly-bar").textContent).toContain("Include a11y?")
    fireEvent.click(screen.getByRole("button", { name: "Reply" }))
    fireEvent.change(screen.getByLabelText("Reply to scout"), { target: { value: "  yes  " } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(props.onReply).toHaveBeenCalledWith("yes")
  })

  it("terminal retryable: shows the summary and Retry restarts the child", () => {
    const props = renderBar(
      node({
        status: "failed",
        terminal: { reason: "failed", summary: "Build failed", at: 9_000, retryable: true }
      })
    )
    expect(screen.getByTestId("subagent-readonly-bar").textContent).toContain("Build failed")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(props.onRetry).toHaveBeenCalledOnce()
  })

  it("terminal not retryable: summary only, no Retry", () => {
    renderBar(
      node({
        status: "completed",
        terminal: { reason: "completed", summary: "All done", at: 9_000, retryable: false }
      })
    )
    expect(screen.getByTestId("subagent-readonly-bar").textContent).toContain("All done")
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })
})
