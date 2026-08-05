// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import type { PlanStepView } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanFileControlsProvider } from "../plan-doc/plan-file-controls.js"
import { PlanWorkerControlsProvider } from "../plan-doc/plan-worker-controls.js"
import { PlanStepCard } from "./plan-step-card.js"

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg aria-label="Rendered diagram"></svg>' }))
}))

vi.mock("mermaid", () => ({ default: mermaid }))

afterEach(() => {
  cleanup()
  globalThis.document.documentElement.style.removeProperty("--sb-panel")
  vi.clearAllMocks()
})

const step: PlanStepView = {
  id: "01",
  title: "Stage one",
  intent: "",
  complexity: "low",
  executionStatus: "running",
  acceptance: [],
  tasks: [],
  diagrams: [],
  files: [{ path: "src/auth/token-store.ts", change: "M", added: 2, removed: 1 }],
  approach: [],
  notes: [],
  agentId: null,
  worker: null,
  reasoningEffort: null
}

describe("PlanStepCard assignment card", () => {
  it("renders the worker route + reasoning + status only when the stage is delegated", () => {
    const { rerender } = render(<PlanStepCard step={step} />)
    // Plain plan-mode stage: no worker, so no assignment card.
    expect(document.querySelector('[data-plan-assignment-card="true"]')).toBeNull()

    rerender(
      <PlanStepCard
        step={{
          ...step,
          executionStatus: "queued",
          agentId: "agent-02",
          worker: "codex · gpt-5.6-terra",
          reasoningEffort: "xhigh"
        }}
      />
    )
    const card = document.querySelector('[data-plan-assignment-card="true"]')
    expect(card).not.toBeNull()
    expect(card).toHaveTextContent("agent-02")
    expect(card).toHaveTextContent("codex · gpt-5.6-terra")
    expect(card).toHaveTextContent("Reasoning: xhigh")
    expect(card).toHaveTextContent("Queued")
  })

  it("offers Stop on a running worker and calls the control", () => {
    const stop = vi.fn()
    render(
      <PlanWorkerControlsProvider controls={{ stop }}>
        <PlanStepCard
          step={{ ...step, executionStatus: "running", agentId: "agent-02", worker: "codex · gpt-5" }}
        />
      </PlanWorkerControlsProvider>
    )
    const button = screen.getByRole("button", { name: "Stop worker agent-02" })
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledWith("agent-02")
    // A queued (non-running) worker offers no Stop control.
    expect(screen.queryByRole("button", { name: /^Retry worker/ })).toBeNull()
  })
})

describe("PlanStepCard file chips", () => {
  it("renders a plan file as a live diff link that opens the asset", () => {
    const open = vi.fn()
    render(
      <PlanFileControlsProvider
        evidence={new Map([["src/auth/token-store.ts", { change: "M", added: 8, removed: 3 }]])}
        knownFiles={new Set(["src/auth/token-store.ts"])}
        open={open}
      >
        <PlanStepCard step={step} />
      </PlanFileControlsProvider>
    )

    // Live worktree evidence (+8 −3) overrides the plan's declared counts (+2 −1).
    const chip = screen.getByRole("button", {
      name: "Open src/auth/token-store.ts (+8 −3)"
    })
    fireEvent.click(chip)
    expect(open).toHaveBeenCalledWith("src/auth/token-store.ts")
  })

  it("falls back to declared counts and is non-interactive without file controls", () => {
    render(<PlanStepCard step={step} />)

    expect(screen.queryByRole("button", { name: /^Open src\/auth/ })).toBeNull()
    expect(screen.getByText("src/auth/token-store.ts")).toBeVisible()
  })

  it("expands the '+N more' file chip to reveal the rest, then collapses", () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      change: "M" as const,
      added: 1,
      removed: 0
    }))
    render(<PlanStepCard step={{ ...step, files }} />)

    // Only the first 12 render; file 14 is hidden behind "+3 more".
    expect(screen.queryByText("src/file-14.ts")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "+3 more" }))
    expect(screen.getByText("src/file-14.ts")).toBeVisible()
    // Collapses again via "Show less".
    fireEvent.click(screen.getByRole("button", { name: "Show less" }))
    expect(screen.queryByText("src/file-14.ts")).toBeNull()
  })
})

describe("PlanStepCard stage review", () => {
  it("renders task progress and the owning stage architecture inline", () => {
    render(
      <PlanStepCard
        step={{
          ...step,
          tasks: [
            { id: "task-1", text: "Project the stage data", status: "completed" },
            { id: "task-2", text: "Render the checklist", status: "in-progress" },
            { id: "task-3", text: "Verify the layout", status: "blocked" }
          ],
          diagrams: [
            { id: "stage-flow", source: "flowchart LR; Contract-->Card" }
          ]
        }}
      />
    )

    expect(screen.getByText("1 of 3 completed")).toBeVisible()
    const taskList = screen.getByRole("list", { name: "Stage tasks" })
    expect(taskList).toHaveTextContent("Project the stage data")
    expect(taskList).toHaveTextContent("Render the checklist")
    expect(taskList).toHaveTextContent("Verify the layout")
    expect(screen.getByRole("region", { name: "Architecture for Stage one" })).toBeVisible()
    expect(screen.getByLabelText("Diagram stage-flow")).toBeVisible()
  })

  it("renders stage diagrams with the token-themed hand-drawn Mermaid look", async () => {
    globalThis.document.documentElement.style.setProperty("--sb-panel", "rgb(1, 2, 3)")
    render(
      <PlanStepCard
        step={{
          ...step,
          diagrams: [{ id: "stage-flow", source: "flowchart LR; Contract-->Card" }]
        }}
      />
    )

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          look: "handDrawn",
          handDrawnSeed: 1,
          theme: "base",
          themeVariables: expect.objectContaining({ primaryColor: "rgb(1, 2, 3)" })
        })
      )
    })
  })
})

describe("PlanStepCard test traceability", () => {
  it("opens a referenced test file and shows its exact named cases", () => {
    const open = vi.fn()
    render(
      <PlanFileControlsProvider
        knownFiles={new Set(["packages/core/src/plan-view.test.ts"])}
        open={open}
      >
        <PlanStepCard
          step={{
            ...step,
            acceptance: [
              {
                id: "01.1",
                text: "Projection keeps diagram ownership.",
                testReferences: [
                  {
                    path: "packages/core/src/plan-view.test.ts",
                    cases: [
                      "keeps every architecture diagram associated with its owning stage",
                      "returns empty sections and stages for an empty plan"
                    ]
                  }
                ],
                status: "pending",
                evidence: null
              }
            ]
          }}
        />
      </PlanFileControlsProvider>
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Open packages/core/src/plan-view.test.ts" })
    )
    expect(open).toHaveBeenCalledWith("packages/core/src/plan-view.test.ts")
    expect(
      screen.getByText("keeps every architecture diagram associated with its owning stage")
    ).toBeVisible()
    expect(screen.getByText("returns empty sections and stages for an empty plan")).toBeVisible()
  })

})
