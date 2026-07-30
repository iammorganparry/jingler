import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DEFAULT_PLAN_TEMPLATE_HTML } from "@jingler/core"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  PlanSettings,
  resolveEffectiveOrchestrator,
  validatePlanTemplate
} from "./plan-settings.js"

afterEach(cleanup)
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe("PlanSettings", () => {
  it("previews and saves a valid custom PRD structure", async () => {
    const onSave = vi.fn()
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE_HTML} onSave={onSave} />)
    const source = screen.getByLabelText("Plan template source")
    fireEvent.change(source, {
      target: { value: DEFAULT_PLAN_TEMPLATE_HTML.replace("<h2>Context</h2>", "<h2>Product context</h2>") }
    })
    expect(screen.getByText("Product context")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  })

  it("rejects invalid plan HTML (no title / no stage)", () => {
    expect(validatePlanTemplate("<p>no title, no stage</p>")).toContain(
      "A plan must start with an <h1> title."
    )
  })

  it("shows the authoritative save failure instead of rejecting silently", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Plan template is invalid: duplicate id"))
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE_HTML} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Plan template source"), {
      target: { value: DEFAULT_PLAN_TEMPLATE_HTML.replace("<h2>Context</h2>", "<h2>Product context</h2>") }
    })
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    expect(await screen.findByText("Plan template is invalid: duplicate id")).toBeTruthy()
  })

  it("shows synchronous save failures instead of throwing from the click handler", async () => {
    const onSave = vi.fn(() => {
      throw new Error("Plan template transport is unavailable")
    })
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE_HTML} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Plan template source"), {
      target: { value: DEFAULT_PLAN_TEMPLATE_HTML.replace("<h2>Context</h2>", "<h2>Product context</h2>") }
    })
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    expect(await screen.findByText("Plan template transport is unavailable")).toBeTruthy()
  })

  it("persists a preferred orchestrator model from the live provider catalogue", async () => {
    const onSaveOrchestrator = vi.fn()
    render(
      <PlanSettings
        source={DEFAULT_PLAN_TEMPLATE_HTML}
        clis={[
          {
            kind: "codex",
            label: "Codex",
            binPath: "/bin/codex",
            version: "1",
            available: true
          }
        ]}
        orchestrator={{ cli: "codex", model: "gpt-5.6-sol" }}
        loadModels={async () => [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
          { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" }
        ]}
        onSaveOrchestrator={onSaveOrchestrator}
      />
    )
    fireEvent.click(await screen.findByRole("combobox", { name: "Orchestrator model" }))
    fireEvent.click(await screen.findByRole("option", { name: "GPT-5.5 Codex" }))
    expect(onSaveOrchestrator).toHaveBeenCalledWith({
      cli: "codex",
      model: "gpt-5.5-codex"
    })
  })

  it("persists concrete worker routes independently for each complexity", async () => {
    const onSaveWorkerRouting = vi.fn()
    render(
      <PlanSettings
        source={DEFAULT_PLAN_TEMPLATE_HTML}
        clis={[
          {
            kind: "claude",
            label: "Claude Code",
            binPath: "/bin/claude",
            version: "1",
            available: true
          }
        ]}
        loadModels={async () => [
          { id: "opus", label: "Opus" },
          { id: "haiku", label: "Haiku" }
        ]}
        onSaveWorkerRouting={onSaveWorkerRouting}
      />
    )

    fireEvent.click(
      await screen.findByRole("combobox", {
        name: "Low complexity worker model"
      })
    )
    fireEvent.click(await screen.findByRole("option", { name: "Haiku" }))

    expect(onSaveWorkerRouting).toHaveBeenCalledWith({
      default: { cli: "claude", model: "opus" },
      low: { cli: "claude", model: "haiku" },
      medium: { cli: "claude", model: "opus" },
      high: { cli: "claude", model: "opus" }
    })
  })

  it("resolves an unavailable preference to the first installed planning provider", () => {
    expect(
      resolveEffectiveOrchestrator(
        [
          {
            kind: "claude",
            label: "Claude Code",
            binPath: "/bin/claude",
            version: "1",
            available: true
          },
          {
            kind: "codex",
            label: "Codex",
            binPath: null,
            version: null,
            available: false
          }
        ],
        { cli: "codex", model: "gpt-5.6-sol" }
      )
    ).toMatchObject({ cli: "claude" })
  })

  it("names the effective model when the configured model disappeared", async () => {
    render(
      <PlanSettings
        source={DEFAULT_PLAN_TEMPLATE_HTML}
        clis={[
          {
            kind: "codex",
            label: "Codex",
            binPath: "/bin/codex",
            version: "1",
            available: true
          }
        ]}
        orchestrator={{ cli: "codex", model: "retired-model" }}
        loadModels={async () => [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }
        ]}
      />
    )

    expect(
      await screen.findByText(
        /Codex model retired-model is unavailable\. New sessions will use Codex model gpt-5\.6-sol\./
      )
    ).toBeTruthy()
  })
})
