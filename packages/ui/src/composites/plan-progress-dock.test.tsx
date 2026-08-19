// @vitest-environment jsdom
import type { PlanDocument, PlanPrdStage, PlanTaskStatus } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanTaskList, planProgressStatus } from "./plan-progress-dock.js"

const stage = (
  id: string,
  title: string,
  taskStatus: PlanTaskStatus = "pending",
  acceptanceStatus: PlanPrdStage["acceptance"][number]["status"] = "pending"
): PlanPrdStage => ({
  id,
  title,
  intent: title,
  approach: [],
  tasks: [{ id: `${id}.task`, text: title, status: taskStatus }],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [{
    id: `${id}.1`,
    text: `${title} is verified.`,
    testReferences: [],
    status: acceptanceStatus,
    evidence: acceptanceStatus === "passed" ? "Verified." : null
  }]
})

const document: PlanDocument = {
  id: "plan-1",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 7,
  status: "executing",
  plan: {
    title: "PRD: Progress",
    sections: [],
    stages: [
      stage("01", "Inspect the code", "completed", "passed"),
      stage("02", "Build the dock", "in-progress"),
      stage("03", "Verify the workflow")
    ],
    annotations: []
  },
  updatedAt: "2026-07-30T00:00:00.000Z",
  updatedBy: "agent"
}

afterEach(cleanup)

describe("PlanTaskList task list", () => {
  it("projects selected-agent task and evidence progress", () => {
    expect(planProgressStatus(stage("1", "Todo"))).toBe("todo")
    expect(planProgressStatus(stage("2", "Working", "in-progress"))).toBe("in-progress")
    expect(planProgressStatus(stage("3", "Blocked", "blocked"))).toBe("blocked")
    expect(planProgressStatus(stage("4", "Failed", "pending", "failed"))).toBe("failed")
    expect(planProgressStatus(stage("5", "Done", "completed", "passed"))).toBe("done")
    expect(planProgressStatus({ ...stage("6", "Verified", "pending", "passed"), tasks: [] })).toBe("done")
  })

  it("expands from the composer summary and opens a stable plan stage", () => {
    const onOpenStage = vi.fn()
    render(<PlanTaskList document={document} onOpenStage={onOpenStage} />)
    const summary = screen.getByRole("button", { name: "Plan tasks: 1 of 3 done" })
    expect(summary.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByTestId("plan-progress-stage-02").textContent).toContain("Build the dock")
    expect(screen.getByTestId("plan-progress-stage-02").textContent).not.toContain("worker")
    fireEvent.click(screen.getByTestId("plan-progress-stage-02"))
    expect(onOpenStage).toHaveBeenCalledWith("02")
  })

  it("reflects a Plan.watch revision without retaining local progress", () => {
    const view = render(<PlanTaskList document={document} />)
    view.rerender(<PlanTaskList document={{
      ...document,
      revision: 8,
      plan: {
        ...document.plan,
        stages: document.plan.stages.map((item) => ({
          ...item,
          tasks: (item.tasks ?? []).map((task) => ({ ...task, status: "completed" as const })),
          acceptance: item.acceptance.map((criterion) => ({
            ...criterion,
            status: "passed" as const,
            evidence: "Verified live."
          }))
        }))
      }
    }} />)
    expect(screen.getByRole("button", { name: "Plan tasks: 3 of 3 done" })).toBeTruthy()
  })
})
