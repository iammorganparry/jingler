import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RuntimeRecoveryCard } from "./runtime-recovery-card.js"

afterEach(cleanup)

const DISMISS = /Dismiss/

describe("RuntimeRecoveryCard", () => {
  it("offers inspection and explicit acknowledgement without exposing arguments", () => {
    const onInspect = vi.fn()
    const onAction = vi.fn()
    render(
      <RuntimeRecoveryCard
        title="Inspect an uncertain workspace mutation"
        message="The tool will not be replayed."
        detail="workspace.edit · workspace · 2026-08-10T12:00:00.000Z"
        actionLabel="Mark inspected"
        onAction={onAction}
        onInspect={onInspect}
      />
    )

    expect(screen.getByRole("region", { name: "Runtime recovery" }).textContent).toContain(
      "workspace.edit"
    )
    expect(screen.queryByText(/arguments|token|secret/i)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Inspect changes" }))
    fireEvent.click(screen.getByRole("button", { name: /Mark inspected/ }))
    expect(onInspect).toHaveBeenCalledOnce()
    expect(onAction).toHaveBeenCalledOnce()
  })

  it("labels its category and can be dismissed", () => {
    const onDismiss = vi.fn()
    render(
      <RuntimeRecoveryCard
        label="MCP server recovery"
        kind="MCP server"
        title="Reconnect runpod"
        message="The runpod MCP server needs authorization before its tools can run."
        actionLabel="Authorize"
        onAction={() => {}}
        onDismiss={onDismiss}
      />
    )

    const card = screen.getByRole("region", { name: "MCP server recovery" })
    expect(card.textContent).toContain("MCP server")
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Reconnect runpod" }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("is not dismissable unless the host opts in", () => {
    render(<RuntimeRecoveryCard title="Reconnect" message="m" actionLabel="Go" onAction={() => {}} />)
    expect(screen.queryByRole("button", { name: DISMISS })).toBeNull()
  })
})
