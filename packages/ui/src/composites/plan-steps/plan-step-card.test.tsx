// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import type { PlanStepView } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanFileControlsProvider } from "../plan-doc/plan-file-controls.js"
import { PlanWorkerControlsProvider } from "../plan-doc/plan-worker-controls.js"
import { PlanStepCard } from "./plan-step-card.js"

afterEach(cleanup)

const step: PlanStepView = {
  id: "01",
  title: "Stage one",
  intent: "",
  complexity: "low",
  executionStatus: "running",
  acceptance: [],
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
})
