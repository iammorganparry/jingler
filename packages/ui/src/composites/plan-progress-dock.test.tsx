// @vitest-environment jsdom
import {
  plannotatorProjectionToPlanDocument,
  type PlanDocument,
  type PlanPrdStage,
  type PlanTaskStatus
} from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanProgressRow, PlanTaskList, planProgressStatus, planStageActionMessage, type PlanProgressStatus } from "./plan-progress-dock.js"

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

  it("renders Plannotator checklist progress through the native task list", () => {
    const projected = plannotatorProjectionToPlanDocument(
      {
        phase: "executing",
        planFilePath: "PLAN.md",
        review: null,
        checklist: [
          { step: 1, text: "Implement", completed: true },
          { step: 2, text: "Verify", completed: false }
        ],
        title: null,
        revision: 1,
        stages: [],
        sections: []
      },
      "session-1",
      "chat-1",
      "2026-08-27T00:00:00.000Z"
    )

    render(<PlanTaskList document={projected} />)

    expect(screen.getByRole("button", { name: "Plan tasks: 1 of 2 done" })).toBeTruthy()
    expect(screen.getByText("Implement")).toBeTruthy()
    expect(screen.getByText("Verify")).toBeTruthy()
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

  const withStage = (extra: PlanPrdStage): PlanDocument => ({
    ...document,
    plan: { ...document.plan, stages: [stage("01", "Inspect the code", "completed", "passed"), extra] }
  })

  it("draws a failed step with a red icon, 'Step N failed', Retry step and Ask agent", () => {
    const onStageAction = vi.fn()
    render(<PlanTaskList document={withStage(stage("02", "Build the dock", "pending", "failed"))} onStageAction={onStageAction} />)
    expect(screen.getByTestId("plan-progress-status-02").textContent).toContain("Step 2 failed")
    expect(screen.getByTestId("plan-progress-status-02").querySelector(".text-state-failed")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry step" }))
    fireEvent.click(screen.getByRole("button", { name: "Ask agent" }))
    expect(onStageAction).toHaveBeenNthCalledWith(1, "retry", { id: "02", step: 2, title: "Build the dock" })
    expect(onStageAction).toHaveBeenNthCalledWith(2, "ask", { id: "02", step: 2, title: "Build the dock" })
  })

  it("draws a blocked step with Ask agent but no red", () => {
    render(<PlanTaskList document={withStage(stage("02", "Build the dock", "blocked"))} onStageAction={vi.fn()} />)
    const line = screen.getByTestId("plan-progress-status-02")
    expect(line.textContent).toContain("Step 2 blocked")
    expect(line.querySelector(".text-state-failed")).toBeNull()
    expect(screen.getByRole("button", { name: "Ask agent" })).toBeTruthy()
  })

  it("draws an interrupted step as 'Stopped by you' with Resume", () => {
    const onStageAction = vi.fn()
    render(<PlanProgressRow status="interrupted" step={2} stage={{ id: "02", title: "Build the dock" }} onStageAction={onStageAction} />)
    expect(screen.getByTestId("plan-progress-status-02").textContent).toContain("Stopped by you")
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(onStageAction).toHaveBeenCalledWith("resume", { id: "02", step: 2, title: "Build the dock" })
  })

  it("renders every PlanProgressStatus; only failed/interrupted/blocked draw a status line", () => {
    const all: ReadonlyArray<PlanProgressStatus> = ["todo", "in-progress", "done", "blocked", "failed", "interrupted"]
    for (const status of all) {
      const view = render(<PlanProgressRow status={status} step={1} stage={{ id: status, title: status }} />)
      expect(screen.getByTestId(`plan-progress-stage-${status}`).getAttribute("data-status")).toBe(status)
      expect(screen.queryByTestId(`plan-progress-status-${status}`) !== null).toBe(["blocked", "failed", "interrupted"].includes(status))
      view.unmount()
    }
  })

  it("hides action buttons when the host does not wire onStageAction", () => {
    render(<PlanTaskList document={withStage(stage("02", "Build the dock", "pending", "failed"))} />)
    expect(screen.queryByRole("button", { name: "Retry step" })).toBeNull()
  })

  it("words each stage action as a chat message", () => {
    expect(planStageActionMessage("retry", { step: 3, title: "Verify" })).toContain('Retry step 3 ("Verify")')
    expect(planStageActionMessage("resume", { step: 3, title: "Verify" })).toContain("Resume")
    expect(planStageActionMessage("ask", { step: 3, title: "Verify" })).toContain("step 3")
  })
})
