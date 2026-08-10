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
    reasoning: ["low", "medium", "high", "xhigh"].map((id, index) => ({
      id: id as "low" | "medium" | "high" | "xhigh",
      label: ["Light", "Medium", "High", "Extra High"][index]!
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
    expect(screen.getByRole("option", { name: "Light" })).toBeDefined()
    expect(screen.queryByRole("option", { name: "Off" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "Extra High" }))
    expect(onSetReasoning).toHaveBeenCalledWith({ enabled: true, effort: "xhigh" })

    rerender(<Composer cli="codex" model="sol" capabilities={capabilities} reasoningEffort="low" onSetReasoning={onSetReasoning} />)
    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    fireEvent.click(screen.getByRole("option", { name: "Default" }))
    expect(onSetReasoning).toHaveBeenLastCalledWith(undefined)
  })

})
