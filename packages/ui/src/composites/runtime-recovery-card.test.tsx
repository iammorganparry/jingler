import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { RuntimeRecoveryCard } from "./runtime-recovery-card.js"

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
})
