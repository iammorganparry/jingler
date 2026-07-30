// @vitest-environment jsdom
import type { PlanDocument, PlanPrdStage } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PlanProgressDock,
  planProgressStatus
} from "./plan-progress-dock.js"

const stage = (
  id: string,
  title: string,
  executionStatus: PlanPrdStage["executionStatus"],
  acceptanceStatus: PlanPrdStage["acceptance"][number]["status"] = "pending"
): PlanPrdStage => ({
  id,
  title,
  intent: title,
  markdown: "",
  acceptance: [
    {
      id: `${id}.1`,
      text: `${title} is verified.`,
      status: acceptanceStatus,
      evidence: acceptanceStatus === "passed" ? "Verified." : null
    }
  ],
  assignment: {
    agentId: `worker-${id}`,
    cli: "codex",
    model: "gpt-5.6-sol",
    reason: "Assigned by the approved plan."
  },
  executionStatus
})

const document: PlanDocument = {
  id: "plan-1",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 7,
  status: "executing",
  source: "<h1>PRD: Progress</h1>",
  projection: {
    title: "PRD: Progress",
    sections: [],
    stages: [
      stage("01", "Inspect the code", "completed", "passed"),
      stage("02", "Build the dock", "running"),
      stage("03", "Verify the workflow", "queued")
    ],
    annotations: []
  },
  updatedAt: "2026-07-30T00:00:00.000Z",
  updatedBy: "agent"
}

afterEach(cleanup)

describe("PlanProgressDock", () => {
  it("projects every canonical worker state into the operator vocabulary", () => {
    expect(planProgressStatus(stage("1", "Todo", "queued"))).toBe("todo")
    expect(planProgressStatus(stage("2", "Working", "running"))).toBe(
      "in-progress"
    )
    expect(planProgressStatus(stage("2b", "Working", "running", "passed"))).toBe(
      "in-progress"
    )
    expect(planProgressStatus(stage("3", "Blocked", "blocked"))).toBe("blocked")
    expect(planProgressStatus(stage("4", "Failed", "failed"))).toBe("failed")
    expect(planProgressStatus(stage("5", "Paused", "interrupted"))).toBe(
      "interrupted"
    )
    expect(planProgressStatus(stage("6", "Done", "queued", "passed"))).toBe(
      "done"
    )
  })

  it("expands from the composer summary and opens a stable plan stage", () => {
    const onOpenStage = vi.fn()
    render(
      <PlanProgressDock document={document} onOpenStage={onOpenStage} />
    )

    const summary = screen.getByRole("button", {
      name: "Plan progress: 1 of 3 done"
    })
    expect(summary.getAttribute("aria-expanded")).toBe("false")
    expect(screen.getByText(/Build the dock · In progress/)).toBeTruthy()

    fireEvent.click(summary)
    expect(summary.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("To do")).toBeTruthy()
    expect(screen.getByText("In progress")).toBeTruthy()
    expect(screen.getByText("Done")).toBeTruthy()
    const completedTitle = screen.getByText("Inspect the code")
    expect(completedTitle.classList.contains("text-muted-foreground")).toBe(
      true
    )
    expect(completedTitle.classList.contains("text-muted")).toBe(false)
    expect(
      screen.getByTestId("plan-progress-stage-02").textContent
    ).toContain("worker-02 · gpt-5.6-sol")

    fireEvent.click(screen.getByTestId("plan-progress-stage-02"))
    expect(onOpenStage).toHaveBeenCalledWith("02")
  })

  it("reflects a Plan.watch revision without retaining local progress", () => {
    const view = render(<PlanProgressDock document={document} />)
    view.rerender(
      <PlanProgressDock
        document={{
          ...document,
          revision: 8,
          projection: {
            ...document.projection,
            stages: document.projection.stages.map((item) => ({
              ...item,
              executionStatus: "completed" as const,
              acceptance: item.acceptance.map((criterion) => ({
                ...criterion,
                status: "passed" as const,
                evidence: "Verified live."
              }))
            }))
          }
        }}
      />
    )

    expect(
      screen.getByRole("button", { name: "Plan progress: 3 of 3 done" })
    ).toBeTruthy()
    expect(screen.getByText("All steps done")).toBeTruthy()
  })
})
