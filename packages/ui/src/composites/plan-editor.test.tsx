// @vitest-environment jsdom
import type { PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanEditor } from "./plan-editor.js"

const source = `# PRD: Interactive plan

<Stage id="01" title="Build editor">
<Acceptance id="01.1" status="pending">Typing is persisted.</Acceptance>
</Stage>`

const document: PlanDocument = {
  id: "plan-1",
  sessionId: "s1",
  producingChatId: "c1",
  revision: 3,
  status: "proposed",
  source,
  projection: {
    title: "PRD: Interactive plan",
    sections: [{ id: "context", title: "Context", markdown: "One plan." }],
    stages: [
      {
        id: "01",
        title: "Build editor",
        intent: "Make the plan editable.",
        markdown: "The source and rendered views round-trip.",
        acceptance: [
          {
            id: "01.1",
            text: "Typing is persisted.",
            status: "pending",
            evidence: null
          }
        ]
      }
    ],
    annotations: []
  },
  updatedAt: "2026-07-28T00:00:00.000Z",
  updatedBy: "agent"
}

afterEach(cleanup)

describe("PlanEditor", () => {
  it("shows the rendered PRD and explicit sync state", () => {
    render(<PlanEditor document={document} draft={source} state="clean" />)
    expect(screen.getByText("PRD: Interactive plan")).toBeTruthy()
    expect(screen.getByText("Build editor")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("Synced")
  })

  it("edits the full MDX source and offers an immediate save", () => {
    const onEdit = vi.fn()
    const onSave = vi.fn()
    render(
      <PlanEditor
        document={document}
        draft={source}
        state="editing"
        onEdit={onEdit}
        onSave={onSave}
      />
    )
    fireEvent.click(screen.getByRole("tab", { name: "Source" }))
    fireEvent.change(screen.getByLabelText("Plan MDX source"), {
      target: { value: `${source}\n\nOperator edit.` }
    })
    fireEvent.click(screen.getByRole("button", { name: "Save now" }))
    expect(onEdit).toHaveBeenCalledWith(`${source}\n\nOperator edit.`)
    expect(onSave).toHaveBeenCalledOnce()
  })

  it("routes inline acceptance status changes", () => {
    const onCriterionChange = vi.fn()
    render(
      <PlanEditor
        document={document}
        draft={source}
        state="clean"
        onCriterionChange={onCriterionChange}
      />
    )
    fireEvent.change(
      screen.getByRole("combobox", { name: /Acceptance status: Typing is persisted/ }),
      { target: { value: "passed" } }
    )
    expect(onCriterionChange).toHaveBeenCalledWith("01.1", "passed", null)
  })

  it("preserves and compares both drafts during a revision conflict", () => {
    const onKeepLocal = vi.fn()
    const onAcceptRemote = vi.fn()
    const remote = { ...document, revision: 4, source: `${source}\n\nRemote edit.` }
    render(
      <PlanEditor
        document={document}
        draft={`${source}\n\nLocal edit.`}
        remote={remote}
        state="conflict"
        onKeepLocal={onKeepLocal}
        onAcceptRemote={onAcceptRemote}
      />
    )
    expect(screen.getByText("Local draft")).toBeTruthy()
    expect(screen.getByText("Remote revision 4")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Keep local and save" }))
    expect(onKeepLocal).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Use remote" }))
    expect(onAcceptRemote).toHaveBeenCalledOnce()
  })

  it("retains the editor and exposes retry after a save failure", () => {
    const onRetry = vi.fn()
    render(
      <PlanEditor
        document={document}
        draft={`${source}\n\nUnsaved.`}
        state="error"
        error="disk full"
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole("alert").textContent).toContain("disk full")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
