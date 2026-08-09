import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { HarnessCapability } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)

const capabilities: ReadonlyArray<HarnessCapability> = [{
  cli: "codex",
  label: "Codex",
  modes: [{ id: "accept-edits", label: "Workspace write", kind: "execute" }],
  models: [{
    id: "sol",
    label: "Sol",
    reasoning: ["minimal", "low", "medium", "high", "xhigh"].map((id, index) => ({
      id: id as "minimal" | "low" | "medium" | "high" | "xhigh",
      label: ["Minimal", "Low", "Medium", "High", "Extra High"][index]!
    }))
  }]
}]

describe("Composer thinking strength", () => {
  it("shows the native harness default until the session overrides it", () => {
    render(<Composer />)
    expect(screen.getByRole("button", { name: "Thinking strength" }).textContent).toContain(
      "Default"
    )
  })

  it("reports a provider-native strength and can restore the default", () => {
    const onSetReasoning = vi.fn()
    const { rerender } = render(
      <Composer cli="codex" model="sol" capabilities={capabilities} reasoningEffort="low" onSetReasoning={onSetReasoning} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    fireEvent.click(screen.getByRole("option", { name: "Extra High" }))
    expect(onSetReasoning).toHaveBeenCalledWith({ enabled: true, effort: "xhigh" })

    rerender(<Composer cli="codex" model="sol" capabilities={capabilities} reasoningEffort="low" onSetReasoning={onSetReasoning} />)
    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    fireEvent.click(screen.getByRole("option", { name: "Default" }))
    expect(onSetReasoning).toHaveBeenLastCalledWith(undefined)
  })

})
