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

    fireEvent.pointerDown(modelChip(), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByText("GPT-5.6-Sol"))

    expect(onSetHarness).toHaveBeenCalledWith("codex", "gpt-5.6-sol")
  })

  it("reports the same harness when picking a sibling model", () => {
    const onSetHarness = vi.fn()
    render(<Composer cli="claude" model="opus" catalog={catalog} onSetHarness={onSetHarness} />)

    fireEvent.pointerDown(modelChip(), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole("menuitem", { name: "sonnet" }))

    expect(onSetHarness).toHaveBeenCalledWith("claude", "sonnet")
  })

  it("shows the current model's label, never the internal value", () => {
    render(<Composer cli="codex" model="gpt-5.6-sol" catalog={catalog} />)
    const chip = screen.getAllByRole("button").find((b) => b.textContent?.includes("GPT-5.6-Sol"))
    expect(chip).toBeDefined()
    expect(chip!.textContent).not.toContain("codex:")
  })

  /**
   * A session can hold a model id the catalogue no longer has — Codex's list is
   * live, so yesterday's id can vanish. The chip must fall back to the harness's
   * first (default) model rather than render a raw composite value.
   */
  it("falls back to the harness default when the session's model is gone", () => {
    render(<Composer cli="codex" model="gpt-5-codex-retired" catalog={catalog} />)
    const chip = screen.getAllByRole("button").find((b) => b.textContent?.includes("GPT-5.6-Sol"))
    expect(chip).toBeDefined()
  })

  it("disables the chip when no harness is installed", () => {
    render(<Composer cli="claude" model="opus" catalog={[]} />)
    // Only the attach-image button remains clickable; no model chip trigger.
    expect(screen.queryByRole("menuitem")).toBeNull()
  })
})

/**
 * Jingler mode owns the model + mode chips. On the orchestrator composer a
 * toggle stands in for them; when it is on there is nothing valid to pick (the
 * orchestrator is automatic on its Settings model), so both chips disappear.
 * Off — or on a plain chat, where the toggle never renders — the chips return.
 */
describe("Composer Jingler toggle", () => {
  const jinglerButton = () =>
    screen.getAllByRole("button").find((b) => b.textContent?.includes("Jingler"))
  const chip = (text: string) =>
    screen.getAllByRole("button").find((b) => b.textContent?.includes(text))

  it("hides the model and mode chips when Jingler mode is on", () => {
    render(
      <Composer
        cli="claude"
        model="opus"
        catalog={catalog}
        allowPlan
        showJinglerToggle
        jinglerMode
      />
    )
    expect(jinglerButton()).toBeDefined()
    expect(chip("opus")).toBeUndefined()
    expect(chip("accept edits")).toBeUndefined()
  })

  it("shows both chips (and the toggle) when Jingler mode is off", () => {
    render(
      <Composer
        cli="claude"
        model="opus"
        catalog={catalog}
        allowPlan
        showJinglerToggle
        jinglerMode={false}
      />
    )
    expect(jinglerButton()).toBeDefined()
    expect(chip("opus")).toBeDefined()
  })

  it("reports the flipped value when the toggle is clicked", () => {
    const onToggle = vi.fn()
    render(
      <Composer
        cli="claude"
        model="opus"
        catalog={catalog}
        showJinglerToggle
        jinglerMode
        onToggleJinglerMode={onToggle}
      />
    )
    fireEvent.click(jinglerButton()!)
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it("disables the Jingler toggle while its chat setting is being persisted", () => {
    render(
      <Composer
        cli="claude"
        model="opus"
        catalog={catalog}
        showJinglerToggle
        jinglerMode
        jinglerModePending
      />
    )
    expect(jinglerButton()).toHaveProperty("disabled", true)
    expect(jinglerButton()?.getAttribute("aria-busy")).toBe("true")
  })

  it("never renders the toggle on a plain (non-orchestrator) chat", () => {
    render(<Composer cli="claude" model="opus" catalog={catalog} />)
    expect(jinglerButton()).toBeUndefined()
    expect(chip("opus")).toBeDefined()
  })
})
