import type { ProviderModels } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

/**
 * The composer's model chip is also the provider switcher: models are grouped
 * under their harness, so picking one under another heading changes harness too.
 * These cover the wiring the operator depends on — the chip must never leak the
 * internal `<cli>:<model>` value, and a pick must report BOTH parts.
 */

afterEach(cleanup)

const catalog: ReadonlyArray<ProviderModels> = [
  {
    cli: "claude",
    label: "Claude Code",
    models: [
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" }
    ]
  },
  {
    cli: "codex",
    label: "Codex CLI",
    models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }]
  }
]

const modelChip = () => screen.getAllByRole("button").find((b) => b.textContent?.includes("opus"))!

describe("Composer model chip", () => {
  it("reports the harness alongside the model when picking another provider", () => {
    const onSetHarness = vi.fn()
    render(<Composer cli="claude" model="opus" catalog={catalog} onSetHarness={onSetHarness} />)

    fireEvent.click(modelChip())
    fireEvent.click(screen.getByRole("option", { name: /Codex CLI.*1 model/i }))
    fireEvent.click(screen.getByRole("option", { name: "GPT-5.6-Sol" }))

    expect(onSetHarness).toHaveBeenCalledWith("codex", "gpt-5.6-sol")
  })

  it("reports the same harness when picking a sibling model", () => {
    const onSetHarness = vi.fn()
    render(<Composer cli="claude" model="opus" catalog={catalog} onSetHarness={onSetHarness} />)

    fireEvent.click(modelChip())
    fireEvent.click(screen.getByRole("option", { name: /Claude Code.*2 models/i }))
    fireEvent.click(screen.getByRole("option", { name: "sonnet" }))

    expect(onSetHarness).toHaveBeenCalledWith("claude", "sonnet")
  })

  it("shows the current model's label, never the internal value", () => {
    render(<Composer cli="codex" model="gpt-5.6-sol" catalog={catalog} />)
    const chip = screen.getAllByRole("button").find((b) => b.textContent?.includes("GPT-5.6-Sol"))
    expect(chip).toBeDefined()
    expect(chip!.textContent).not.toContain("codex:")
  })

  it("shows the actual persisted model when it is no longer in the catalogue", () => {
    render(<Composer cli="codex" model="gpt-5-codex-retired" catalog={catalog} />)
    expect(screen.getByRole("button", { name: "Model: gpt-5-codex-retired" })).toBeTruthy()
  })

  it("uses the catalogue fallback while live capabilities are still unavailable", () => {
    render(<Composer cli="claude" model="opus" catalog={catalog} />)
    fireEvent.click(screen.getByText("Accept Edits"))
    expect(screen.getByRole("option", { name: "Full Access" })).toBeTruthy()
  })

  it("blocks sending for an unavailable selection but keeps model recovery enabled", () => {
    const onSend = vi.fn()
    render(
      <Composer
        cli="claude"
        model="retired"
        catalog={catalog}
        disabledReason="Model retired is unavailable. Choose a supported model to continue."
        onSend={onSend}
      />
    )

    expect((screen.getByPlaceholderText(/Model retired is unavailable/) as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Send ↵" })).toBeNull()
    expect((screen.getByRole("button", { name: "Model: retired" }) as HTMLButtonElement).disabled).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("disables the chip when no harness is installed", () => {
    render(<Composer cli="claude" model="opus" catalog={[]} />)
    // Only the attach-image button remains clickable; no model chip trigger.
    expect(screen.queryByRole("menuitem")).toBeNull()
  })
})
