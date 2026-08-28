// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { plannotatorProjectionToPlanDocument } from "@jingler/core"
import { ConversationView } from "./conversation-view.js"

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

  it("renders the native transcript card as a read-only checklist projection", () => {
    const document = plannotatorProjectionToPlanDocument(
      {
        phase: "executing",
        planFilePath: "/tmp/plan.md",
        review: null,
        checklist: [
          { step: 1, text: "Inspect the runtime", completed: true },
          { step: 2, text: "Verify recovery", completed: false }
        ]
      },
      "session-1",
      "chat-1",
      "2026-08-13T00:00:00.000Z"
    )

    render(
      <ConversationView
        messages={[]}
        mode="plan"
        planDocument={document}
      />
    )

    expect(screen.getByTestId("plannotator-transcript-card")).toBeTruthy()
    expect(screen.getAllByText("Inspect the runtime").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Verify recovery").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
  })
})
