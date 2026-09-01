// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { plannotatorProjectionToPlanDocument, type Message } from "@jingler/core"
import { ConversationView, planTranscriptAnchorIndex } from "./conversation-view.js"

describe("ConversationView Plannotator projection", () => {
  it("does not render a transcript card for an empty projection", () => {
    const document = plannotatorProjectionToPlanDocument(
      {
        phase: "idle",
        planFilePath: null,
        review: null,
        checklist: []
      },
      "session-1",
      "chat-1",
      "2026-08-13T00:00:00.000Z"
    )

    render(
      <ConversationView
        messages={[]}
        mode="auto"
        planDocument={document}
      />
    )

    expect(screen.queryByTestId("plannotator-transcript-card")).toBeNull()
  })

  it("does not append an active plan when its plan-tool turn is not loaded", () => {
    const document = plannotatorProjectionToPlanDocument(
      {
        phase: "executing",
        planFilePath: "/tmp/plan.md",
        review: null,
        checklist: [{ step: 1, text: "Inspect the runtime", completed: true }]
      },
      "session-1",
      "chat-1",
      "2026-08-13T00:00:00.000Z"
    )

    render(<ConversationView messages={[]} mode="plan" planDocument={document} />)

    expect(screen.queryByTestId("plannotator-transcript-card")).toBeNull()
  })

  it("anchors to the latest non-failed plan creation or revision tool turn", () => {
    const message = (
      id: string,
      toolName?: string,
      status: "running" | "success" | "error" = "success"
    ): Message => ({
      id,
      role: "assistant",
      streaming: false,
      createdAt: `2026-08-13T00:00:0${id}.000Z`,
      parts: toolName === undefined ? [] : [{
        _tag: "Tool",
        tool: {
          id: `tool-${id}`,
          name: toolName,
          target: "PLAN.md",
          status,
          meta: null,
          diff: null,
          preview: null
        }
      }]
    })

    expect(planTranscriptAnchorIndex([
      message("1", "plannotator_submit_plan"),
      message("2", "plannotator_update_plan", "error"),
      message("3", "plannotator_update_plan", "running")
    ])).toBe(0)
    expect(planTranscriptAnchorIndex([
      message("1", "plannotator_submit_plan"),
      message("2", "plannotator_submit_plan", "running")
    ])).toBe(1)
  })
})
