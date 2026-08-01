// @vitest-environment jsdom
import type { PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanEditor } from "./plan-editor.js"
import { PlanDocEditor } from "./plan-doc/plan-doc-editor.js"
import { planAssignmentReasoningLabel } from "./plan-doc/plan-stage-node.js"

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
  it("renders plan files as live diff links", async () => {
    const onOpenFile = vi.fn()
    const withFile = source.replace(
      '<div data-acceptance="01.1"',
      '<ul data-files><li>src/editor.ts</li></ul><div data-acceptance="01.1"'
    )
    const patch = `diff --git a/src/editor.ts b/src/editor.ts
--- a/src/editor.ts
+++ b/src/editor.ts
@@ -1 +1,2 @@
 old
+new`
    render(
      <PlanEditor
        document={{ ...document, source: withFile }}
        draft={withFile}
        state="clean"
        patch={patch}
        knownFiles={new Set(["src/editor.ts"])}
        onOpenFile={onOpenFile}
      />
    )

    const link = await screen.findByRole("button", {
      name: "Open src/editor.ts (+1 −0)"
    })
    fireEvent.click(link)
    expect(onOpenFile).toHaveBeenCalledWith("src/editor.ts")
  })

  it("defers an external document replacement until a focused editor blurs", async () => {
    const first = "<h1>Focused plan</h1><p>Keep the live caret.</p>"
    const remote = "<h1>Remote plan</h1><p>Apply after editing.</p>"
    const rendered = render(<PlanDocEditor value={first} />)
    const editor = screen.getByLabelText("Plan document")

    editor.focus()
    expect(globalThis.document.activeElement).toBe(editor)
    rendered.rerender(<PlanDocEditor value={remote} />)

    expect(screen.getByText("Keep the live caret.")).toBeTruthy()
    expect(screen.queryByText("Apply after editing.")).toBeNull()

    fireEvent.blur(editor)
    await waitFor(() => expect(screen.getByText("Apply after editing.")).toBeTruthy())
  })

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
    const dock = screen.getByTestId("plan-floating-actions")
    expect(dock.className).toContain("bottom-4")
    expect(dock.className).toContain("absolute")
    expect(within(dock).getByText("proposed")).toBeTruthy()
    expect(within(dock).getByText("revision 3")).toBeTruthy()
    expect(within(dock).getByRole("status").textContent).toContain("Synced")
    expect(screen.getAllByRole("status")).toHaveLength(1)
  })

  it("labels explicit and provider-default assignment reasoning", () => {
    expect(planAssignmentReasoningLabel("true", "high")).toBe(
      "Reasoning: high"
    )
    expect(planAssignmentReasoningLabel("false", null)).toBe("Reasoning: off")
    expect(planAssignmentReasoningLabel(null, null)).toBe(
      "Reasoning: provider default"
    )
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
