// @vitest-environment jsdom
import type { PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

const document: PlanDocument = {
  id: "composer-plan",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 1,
  status: "executing",
  plan: {
    title: "Composer plan",
    sections: [],
    annotations: [],
    stages: [{
      id: "stage-1",
      title: "Embed the task list",
      intent: "Keep status inside the composer.",
      approach: [],
      tasks: [{ id: "task-1", text: "Embed the task list", status: "in-progress" }],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: []
    }]
  },
  updatedAt: "2026-08-01T00:00:00.000Z",
  updatedBy: "agent"
}

afterEach(cleanup)

describe("Composer plan task list", () => {
  it("embeds canonical plan tasks in the composer and routes stage selection", () => {
    const onOpenPlanStage = vi.fn()
    render(<Composer planDocument={document} onOpenPlanStage={onOpenPlanStage} />)

    const composer = screen.getByTestId("composer")
    const taskList = screen.getByTestId("plan-task-list")
    expect(composer.contains(taskList)).toBe(true)

    // The drawer's Plan tab labels the list (with a done/total badge); the list
    // itself renders bare and always expanded inside the tab.
    const planTab = screen.getByRole("tab", { name: /Plan/ })
    expect(planTab.getAttribute("aria-selected")).toBe("true")
    expect(planTab.textContent).toContain("0/1")
    fireEvent.click(screen.getByTestId("plan-progress-stage-stage-1"))
    expect(onOpenPlanStage).toHaveBeenCalledWith("stage-1")
  })

  it("extends the Plan tab to the overview, revealing nested subtasks", () => {
    const withSubtask: PlanDocument = {
      ...document,
      plan: {
        ...document.plan,
        stages: [{
          ...document.plan.stages[0]!,
          title: "Build the consent route",
          tasks: [{ id: "t-a", text: "Wire the OAuth callback", status: "pending" }]
        }]
      }
    }
    render(<Composer planDocument={withSubtask} />)

    // Compact list shows the stage, not its subtasks.
    expect(screen.queryByText("Wire the OAuth callback")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Extend to plan overview" }))
    expect(screen.getByText("Wire the OAuth callback")).toBeDefined()
  })
})
