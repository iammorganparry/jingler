import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HarnessCapability } from "@jingler/core"
import { ModelBrowser } from "./model-browser.js"

const capabilities: ReadonlyArray<HarnessCapability> = [
  {
    cli: "claude",
    label: "Claude",
    modes: [{ id: "ask", label: "Ask", kind: "execute" }],
    models: [{ id: "opus", label: "Opus", description: "Deep reasoning" }]
  },
  {
    cli: "codex",
    label: "Codex",
    modes: [{ id: "auto", label: "Auto", kind: "execute" }],
    models: [
      { id: "sol", label: "Sol", description: "Frontier coding" },
      { id: "luna", label: "Luna", description: "Fast coding" }
    ]
  }
]

afterEach(cleanup)

describe("ModelBrowser", () => {
  it("aligns the harness search inset with the menu items", () => {
    render(<ModelBrowser cli="claude" model="opus" capabilities={capabilities} />)

    fireEvent.click(screen.getByRole("button", { name: "Model: Opus" }))

    const search = screen.getByPlaceholderText("Search harnesses…")
    expect(search.parentElement?.className).toContain("px-2")
    expect(search.parentElement?.className).not.toContain("px-3")
  })

  it("shows only supported providers and switches provider plus model", () => {
    const onSelect = vi.fn()
    render(
      <ModelBrowser
        capabilities={capabilities}
        cli="claude"
        model="opus"
        onSelect={onSelect}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /Opus/i }))
    expect(screen.getByText("Claude")).toBeTruthy()
    expect(screen.getByText("Codex")).toBeTruthy()
    expect(screen.queryByText("OpenCode")).toBeNull()

    fireEvent.click(screen.getByRole("option", { name: /Codex.*2 models/i }))
    fireEvent.click(screen.getByRole("option", { name: /Luna/i }))
    expect(onSelect).toHaveBeenCalledWith("codex", "luna")
  })

  it("searches the selected provider's live model descriptions", () => {
    render(
      <ModelBrowser
        capabilities={capabilities}
        cli="codex"
        model="sol"
        onSelect={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /Sol/i }))
    fireEvent.click(screen.getByRole("option", { name: /Codex.*2 models/i }))
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "fast" }
    })
    expect(screen.getByText("Luna")).toBeTruthy()
    expect(screen.queryByText("Frontier coding")).toBeNull()
  })
})
