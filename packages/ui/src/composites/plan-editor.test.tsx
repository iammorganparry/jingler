// @vitest-environment jsdom
import type { PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanEditor } from "./plan-editor.js"

const source = `<h1>PRD: Interactive plan</h1>
<h2>Context</h2>
<p>One plan, one revision.</p>
<section data-stage="01" data-title="Build editor">
<h3>Intent</h3><p>Make the plan editable.</p>
<div data-acceptance="01.1" data-status="pending">Typing is persisted.</div>
</section>`

const document: PlanDocument = {
  id: "plan-1",
  sessionId: "s1",
  producingChatId: "c1",
  revision: 3,
  status: "proposed",
  source,
  projection: {
    title: "PRD: Interactive plan",
    sections: [{ id: "context", title: "Context", markdown: "<p>One plan, one revision.</p>" }],
    stages: [
      {
        id: "01",
        title: "Build editor",
        intent: "Make the plan editable.",
        markdown: "",
        acceptance: [{ id: "01.1", text: "Typing is persisted.", status: "pending", evidence: null }]
      }
    ],
    annotations: []
  },
  updatedAt: "2026-07-28T00:00:00.000Z",
  updatedBy: "agent"
}

afterEach(cleanup)

describe("PlanEditor", () => {
  it("renders transient source without revision or plan actions", () => {
    render(
      <PlanEditor
        document={null}
        draft={source}
        transientState="composing"
        state="clean"
      />
    )
    expect(screen.getByRole("status").textContent).toContain("Composing")
    expect(screen.queryByText(/^revision \d+$/)).toBeNull()
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull()
    expect(screen.getByLabelText("Plan document").getAttribute("contenteditable")).toBe(
      "false"
    )
  })

  it("renders the plan document in the Tiptap editor and shows the sync state", () => {
    render(<PlanEditor document={document} draft={source} state="clean" />)
    expect(screen.getByText("PRD: Interactive plan")).toBeTruthy()
    expect(screen.getByText("Typing is persisted.")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("Synced")
    expect(screen.getByTestId("plan-floating-actions").className).toContain("bottom-4")
    expect(screen.getByTestId("plan-floating-actions").className).toContain("absolute")
  })

  it("shows the conflict banner with both revisions when state is conflict", () => {
    const remote: PlanDocument = { ...document, revision: 4, source }
    render(
      <PlanEditor document={document} draft={source} remote={remote} state="conflict" />
    )
    expect(screen.getByText(/Revision 4 arrived/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Keep local and save" })).toBeTruthy()
  })

  it("derives a live minimap and focuses the selected document block", async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<PlanEditor document={document} draft={source} state="clean" />)

    const minimap = await screen.findByRole("navigation", { name: "Plan minimap" })
    fireEvent.click(
      await within(minimap).findByRole("button", { name: /Build editor/ })
    )
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(
      globalThis.document.activeElement?.getAttribute("data-plan-minimap-id")
    ).toBe("stage:01")
  })
})
