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

    fireEvent.pointerDown(screen.getByRole("button", { name: /Opus/i }), {
      button: 0,
      ctrlKey: false
    })
    expect(screen.getByText("Claude")).toBeTruthy()
    expect(screen.getByText("Codex")).toBeTruthy()
    expect(screen.queryByText("OpenCode")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /Codex.*2 models/i }))
    fireEvent.click(screen.getByRole("button", { name: /Luna/i }))
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

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sol/i }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("button", { name: /Codex.*2 models/i }))
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "fast" }
    })
    expect(screen.getByText("Luna")).toBeTruthy()
    expect(screen.queryByText("Frontier coding")).toBeNull()
  })
})
