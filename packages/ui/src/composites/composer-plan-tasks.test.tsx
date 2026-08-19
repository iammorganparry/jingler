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

    expect(screen.getByRole("button", { name: "Plan tasks: 0 of 1 done" }).getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(screen.getByTestId("plan-progress-stage-stage-1"))
    expect(onOpenPlanStage).toHaveBeenCalledWith("stage-1")
  })
})
