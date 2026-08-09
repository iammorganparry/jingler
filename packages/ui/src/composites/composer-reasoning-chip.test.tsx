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
    reasoning: ["minimal", "low", "medium", "high", "xhigh"].map((id) => ({
      id: id as "minimal" | "low" | "medium" | "high" | "xhigh",
      label: id
    }))
  }]
}]

describe("Composer thinking strength", () => {
  it("shows the native harness default until the session overrides it", () => {
    render(<Composer />)
    expect(screen.getByRole("button", { name: "Thinking strength" }).textContent).toContain(
      "default"
    )
  })

  it("reports a provider-native strength and can restore the default", () => {
    const onSetReasoning = vi.fn()
    const { rerender } = render(
      <Composer cli="codex" model="sol" capabilities={capabilities} reasoningEffort="low" onSetReasoning={onSetReasoning} />
    )

    fireEvent.pointerDown(screen.getByRole("button", { name: "Thinking strength" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "xhigh" }))
    expect(onSetReasoning).toHaveBeenCalledWith({ enabled: true, effort: "xhigh" })

    rerender(<Composer cli="codex" model="sol" capabilities={capabilities} reasoningEffort="low" onSetReasoning={onSetReasoning} />)
    fireEvent.pointerDown(screen.getByRole("button", { name: "Thinking strength" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "default" }))
    expect(onSetReasoning).toHaveBeenLastCalledWith(undefined)
  })

})
