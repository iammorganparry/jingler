import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PlanPrd, WorkerRoutingConfig } from "@jingler/core"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

/** A structured plan template with a Context section and one stage to edit. */
const TEMPLATE: PlanPrd = {
  title: "PRD: Template",
  sections: [
    {
      id: "context",
      title: "Context",
      blocks: [{ kind: "prose", id: "c1", text: "Why this work matters." }]
    }
  ],
  stages: [
    {
      id: "01",
      title: "First stage",
      intent: "Do the work.",
      approach: [],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "01.1", text: "It works.", status: "pending", evidence: null }],
      dependencies: []
    }
  ],
  annotations: []
}
const DEFAULT_PLAN_TEMPLATE_HTML = JSON.stringify(TEMPLATE)
import {
  PlanSettings,
  resolveEffectiveOrchestrator,
  validatePlanTemplate,
  workerReasoningOptionsFor
} from "./plan-settings.js"

afterEach(cleanup)
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe("PlanSettings", () => {
  it("offers only provider-default reasoning when explicit settings are unsupported", () => {
    expect(workerReasoningOptionsFor("cursor")).toStrictEqual([
      { value: "provider-default", label: "Provider default" }
    ])
    expect(workerReasoningOptionsFor("claude")).toContainEqual({
      value: "max",
      label: "max"
    })
    expect(workerReasoningOptionsFor("codex")).not.toContainEqual({
      value: "max",
      label: "max"
    })
  })

  it("previews and saves a valid custom PRD structure", async () => {
    const onSave = vi.fn()
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE_HTML} onSave={onSave} />)
    const source = screen.getByLabelText("Plan template source")
    fireEvent.change(source, {
      target: { value: DEFAULT_PLAN_TEMPLATE_HTML.replace('"Context"', '"Product context"') }
    })
    expect(screen.getByText("Product context")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save template" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  })

  it("rejects a template that is not a structured plan", () => {
    expect(validatePlanTemplate("<p>no longer HTML</p>")).toContain(
      "The plan template is not valid JSON."
    )
    expect(validatePlanTemplate('{ "not": "a plan" }')).toContain(
      "The plan template is not a valid structured plan."
    )
  })

  it("shows the authoritative save failure instead of rejecting silently", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Plan template is invalid: duplicate id"))
    render(<PlanSettings source={DEFAULT_PLAN_TEMPLATE_HTML} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Plan template source"), {
      target: { value: DEFAULT_PLAN_TEMPLATE_HTML.replace('"Context"', '"Product context"') }
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
      target: { value: DEFAULT_PLAN_TEMPLATE_HTML.replace('"Context"', '"Product context"') }
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

  it("persists a distinct provider-compatible reasoning choice for every route bucket", async () => {
    const onSaveWorkerRouting = vi.fn()
    let routing: WorkerRoutingConfig = {
      default: { cli: "claude" as const, model: "opus" },
      low: { cli: "claude" as const, model: "opus" },
      medium: { cli: "claude" as const, model: "opus" },
      high: { cli: "claude" as const, model: "opus" }
    }
    const props = () => ({
      source: DEFAULT_PLAN_TEMPLATE_HTML,
      clis: [
        {
          kind: "claude" as const,
          label: "Claude Code",
          binPath: "/bin/claude",
          version: "1",
          available: true
        }
      ],
      loadModels: async () => [{ id: "opus", label: "Opus" }],
      workerRouting: routing,
      onSaveWorkerRouting: (next: WorkerRoutingConfig) => {
        routing = next
        onSaveWorkerRouting(next)
      }
    })
    const rendered = render(<PlanSettings {...props()} />)
    const selectReasoning = async (label: string, option: string) => {
      fireEvent.click(
        await screen.findByRole("combobox", { name: `${label} worker reasoning` })
      )
      fireEvent.click(await screen.findByRole("option", { name: option }))
      rendered.rerender(<PlanSettings {...props()} />)
    }

    await selectReasoning("Default", "Thinking on · provider default effort")
    await selectReasoning("Low complexity", "low")
    await selectReasoning("Medium complexity", "high")
    await selectReasoning("High complexity", "max")

    expect(onSaveWorkerRouting).toHaveBeenLastCalledWith({
      default: {
        cli: "claude",
        model: "opus",
        reasoning: { enabled: true }
      },
      low: {
        cli: "claude",
        model: "opus",
        reasoning: { enabled: true, effort: "low" }
      },
      medium: {
        cli: "claude",
        model: "opus",
        reasoning: { enabled: true, effort: "high" }
      },
      high: {
        cli: "claude",
        model: "opus",
        reasoning: { enabled: true, effort: "max" }
      }
    })
  })

  it("offers only provider-compatible efforts and flags an incompatible saved value", async () => {
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
          },
          {
            kind: "codex",
            label: "Codex",
            binPath: "/bin/codex",
            version: "1",
            available: true
          }
        ]}
        loadModels={async (cli) => [
          cli === "claude"
            ? { id: "opus", label: "Opus" }
            : { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }
        ]}
        workerRouting={{
          default: { cli: "claude", model: "opus" },
          low: {
            cli: "codex",
            model: "gpt-5.6-sol",
            reasoning: { enabled: true, effort: "max" }
          },
          medium: { cli: "claude", model: "opus" },
          high: { cli: "claude", model: "opus" }
        }}
      />
    )

    expect(
      await screen.findByText(
        "Unavailable saved routes are using the configured default: Low complexity."
      )
    ).toBeTruthy()
    cleanup()
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
        loadModels={async () => [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }
        ]}
        workerRouting={{
          default: { cli: "codex", model: "gpt-5.6-sol" },
          low: { cli: "codex", model: "gpt-5.6-sol" },
          medium: { cli: "codex", model: "gpt-5.6-sol" },
          high: { cli: "codex", model: "gpt-5.6-sol" }
        }}
      />
    )
    fireEvent.click(
      await screen.findByRole("combobox", {
        name: "Low complexity worker reasoning"
      })
    )
    expect(screen.queryByRole("option", { name: "max" })).toBeNull()
    expect(screen.getByRole("option", { name: "minimal" })).toBeTruthy()
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

  it("uses the core resolver's provider default when a saved model disappeared", () => {
    expect(
      resolveEffectiveOrchestrator(
        [
          {
            kind: "codex",
            label: "Codex",
            binPath: "/bin/codex",
            version: "1",
            available: true
          }
        ],
        { cli: "codex", model: "retired-model" },
        [
          {
            cli: "codex",
            models: [
              { id: "first-live", label: "First live" },
              { id: "configured-default", label: "Configured default" }
            ]
          }
        ],
        {
          codex: {
            enabled: true,
            defaultMode: "ask",
            defaultModel: "configured-default"
          }
        }
      )
    ).toEqual({ cli: "codex", model: "configured-default" })
  })
})
