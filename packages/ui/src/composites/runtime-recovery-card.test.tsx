import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AlertCircle, Server } from "lucide-react"
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
    fireEvent.click(screen.getByRole("button", { name: DISMISS }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("is not dismissable unless the host opts in", () => {
    render(<RuntimeRecoveryCard title="Reconnect" message="m" actionLabel="Go" onAction={() => {}} />)
    expect(screen.queryByRole("button", { name: DISMISS })).toBeNull()
  })

  describe("three variants", () => {
    it("renders MCP server variant with neutral body and dismissal", () => {
      const onAction = vi.fn()
      const onDismiss = vi.fn()
      render(
        <RuntimeRecoveryCard
          label="MCP server recovery"
          kind="MCP server"
          title="Reconnect runpod"
          message="The runpod MCP server needs authorization before its tools can run."
          icon={<Server size={13} />}
          actionLabel="Authorize"
          onAction={onAction}
          onDismiss={onDismiss}
        />
      )

      expect(screen.getByRole("region", { name: "MCP server recovery" })).toBeTruthy()
      expect(screen.getByText("MCP server")).toBeTruthy()
      expect(screen.getByText("Reconnect runpod")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Authorize" }))
      expect(onAction).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole("button", { name: DISMISS }))
      expect(onDismiss).toHaveBeenCalledOnce()
    })

    it("renders Provider variant with neutral body", () => {
      const onAction = vi.fn()
      render(
        <RuntimeRecoveryCard
          label="Provider recovery"
          kind="Provider"
          title="Choose a runtime connection"
          message="This migrated conversation is readable, but needs a certified connection and model before it can continue."
          actionLabel="Open providers"
          onAction={onAction}
        />
      )

      expect(screen.getByRole("region", { name: "Provider recovery" })).toBeTruthy()
      expect(screen.getByText("Provider")).toBeTruthy()
      expect(screen.getByText("Choose a runtime connection")).toBeTruthy()
      expect(screen.getByRole("button", { name: "Open providers" })).toBeTruthy()
    })

    it("renders Runtime variant with red icon on failure and Inspect action", () => {
      const onAction = vi.fn()
      const onInspect = vi.fn()
      render(
        <RuntimeRecoveryCard
          label="Runtime recovery"
          kind="Runtime"
          title="The agent process exited unexpectedly"
          message="Restart the runtime and check logs for details."
          icon={<AlertCircle size={13} />}
          failed
          actionLabel="Restart runtime"
          onAction={onAction}
          inspectLabel="Inspect"
          onInspect={onInspect}
        />
      )

      const card = screen.getByRole("alert")
      expect(card).toBeTruthy()
      expect(screen.getByText("Runtime")).toBeTruthy()
      expect(screen.getByText("The agent process exited unexpectedly")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Inspect" }))
      expect(onInspect).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole("button", { name: "Restart runtime" }))
      expect(onAction).toHaveBeenCalledOnce()
    })
  })
})
