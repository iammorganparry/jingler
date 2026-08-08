// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import type { Plan, PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlanReview } from "./plan-review.js"

const source = JSON.stringify({
  mode: "draft",
  plan: {
    title: "PRD: Editor-only plan",
    sections: [],
    stages: [
      {
        id: "01",
        title: "Build",
        intent: "Use one document editor.",
        approach: [],
        files: [],
        diagrams: [],
        notes: [],
        walkthrough: [
          { kind: "prose", id: "01-why", text: "Keep the document boundary explicit." },
          { kind: "code", id: "01-code", language: "tsx", code: "<PlanReview document={plan} />" }
        ],
        acceptance: [
          { id: "01.1", text: "Legacy rails are absent.", status: "pending", evidence: null }
        ],
        dependencies: []
      }
    ],
    annotations: []
  }
})

const document: PlanDocument = {
  id: "plan-1",
  sessionId: "s1",
  producingChatId: "c1",
  revision: 2,
  status: "proposed",
  plan: {
    title: "PRD: Editor-only plan",
    sections: [],
    stages: [
      {
        id: "01",
        title: "Build",
        intent: "Use one document editor.",
        approach: [],
        files: [],
        diagrams: [],
        notes: [],
        walkthrough: [
          { kind: "prose", id: "01-why", text: "Keep the document boundary explicit." },
          { kind: "code", id: "01-code", language: "tsx", code: "<PlanReview document={plan} />" }
        ],
        acceptance: [
          {
            id: "01.1",
            text: "Legacy rails are absent.",
            status: "pending",
            evidence: null
          }
        ]
      }
    ],
    annotations: []
  },
  updatedAt: "2026-07-29T00:00:00.000Z",
  updatedBy: "agent"
}

const legacyPlan: Plan = {
  id: "legacy-plan",
  summary: "Legacy projection",
  status: "proposed",
  structured: true,
  raw: "# Stored legacy plan\n\nThis is the original **Markdown output**.",
  graph: null,
  comments: [],
  steps: [
    {
      id: "s1",
      number: "01",
      title: "Legacy step",
      intent: "This must not render.",
      approach: [],
      kind: "step",
      condition: null,
      parentId: null,
      dependsOn: [],
      blocks: [],
      files: [],
      guards: [],
      code: null,
      graph: null,
      diff: null,
      status: "proposed",
      flagged: false,
      changed: false
    }
  ]
}

afterEach(cleanup)

describe("PlanReview", () => {
  it("keeps a streamed plan read-only, then shows the step outline once canonical", async () => {
    const canonicalPlan: Plan = {
      ...legacyPlan,
      id: "plan-stream",
      raw: source,
      summary: "Editor-only plan"
    }
    const view = render(
      <PlanReview
        plan={null}
        streamingDraft={{
          id: "plan-stream",
          source,
          phase: "composing"
        }}
      />
    )

    // While composing, the partial DTO renders read-only as the step outline and
    // the single loader is the disabled "Composing plan" button — no Approve.
    expect(await screen.findByText("Build")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Composing plan" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull()

    // Once canonical, the Steps page presents the digestible step outline and an
    // Approve action — with no sync/revision indicator (the plan is read-only).
    view.rerender(
      <PlanReview plan={canonicalPlan} document={{ ...document, id: "plan-stream" }} />
    )
    expect(screen.queryByLabelText("Plan document")).toBeNull()
    expect(screen.getByText("Build")).toBeTruthy()
    expect(screen.queryByText("revision 2")).toBeNull()
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy()
  })

  it("degrades gracefully on a malformed streamed plan instead of crashing", async () => {
    // A complete-but-malformed agent emission: the stage omits every required
    // array (files/notes/acceptance/…). The outline/architecture views .map over
    // those, so without normalization this would throw during render.
    const malformed = JSON.stringify({
      mode: "draft",
      plan: {
        title: "PRD: Malformed",
        stages: [
          {
            id: "01",
            title: "Broken stage",
            tasks: [null, { id: "task", text: "Still readable", status: "unknown" }],
            diagrams: [null, { id: "diagram", source: 42 }],
            acceptance: [
              {
                id: "criterion",
                text: "Malformed references do not crash.",
                status: "unknown",
                evidence: {},
                testReferences: [null, { path: 42, cases: null }]
              }
            ]
          }
        ]
      }
    })
    expect(() =>
      render(
        <PlanReview
          plan={null}
          streamingDraft={{ id: "plan-malformed", source: malformed, phase: "composing" }}
        />
      )
    ).not.toThrow()
    expect(await screen.findByText("Broken stage")).toBeTruthy()
    expect(screen.getByText("Still readable")).toBeTruthy()
  })

  it("lands a progress-dock deep link on its step in the Steps outline", async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const onSelectStep = vi.fn()
    render(
      <PlanReview
        plan={null}
        document={document}
        selectedStepId="01"
        onSelectStep={onSelectStep}
      />
    )

    expect(await screen.findByText("Build")).toBeTruthy()
    expect(onSelectStep).toHaveBeenCalledWith("01")
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it("renders the step outline when a canonical document exists", () => {
    render(<PlanReview plan={legacyPlan} document={document} />)

    expect(screen.getByText("Build")).toBeTruthy()
    expect(screen.getByText("Legacy rails are absent.")).toBeTruthy()
    expect(screen.queryByLabelText("Resize step list")).toBeNull()
    expect(screen.queryByLabelText("Resize changes")).toBeNull()
  })

  it("links compact Steps to the cohesive Guide", async () => {
    render(<PlanReview plan={null} document={document} />)

    // Steps page: the step outline.
    expect(screen.getByText("Build")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open guide for Build" }))
    expect(screen.getByRole("tab", { name: "Guide" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("Keep the document boundary explicit.")).toBeTruthy()
    expect(screen.getByText("<PlanReview document={plan} />")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open step Build" }))
    expect(screen.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true")

    expect(screen.queryByRole("tab", { name: "Architecture" })).toBeNull()
    expect(screen.queryByRole("tab", { name: "Walkthrough" })).toBeNull()

    // Back to Steps.
    fireEvent.click(screen.getByRole("tab", { name: "Steps" }))
    expect(screen.getByText("Build")).toBeTruthy()
  })

  it("shows TLDR first and jumps from a Guide stage to its Steps card", async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const architectureDocument: PlanDocument = {
      ...document,
      plan: {
        ...document.plan,
        sections: [
          {
            id: "context",
            title: "Context",
            blocks: [{ kind: "prose", id: "context-copy", text: "Background detail." }]
          },
          {
            id: "tldr",
            title: "TL;DR",
            blocks: [{ kind: "prose", id: "tldr-copy", text: "Outcome first." }]
          }
        ],
        stages: document.plan.stages.map((stage) => ({
          ...stage,
          diagrams: [{ id: "build-flow", source: "flowchart LR; Plan-->Build" }]
        }))
      }
    }

    render(<PlanReview plan={null} document={architectureDocument} />)
    fireEvent.click(screen.getByRole("tab", { name: "Guide" }))

    const headings = screen.getAllByRole("heading", { level: 2 })
    expect(headings[0]).toHaveTextContent("TL;DR")
    expect(screen.getByText("Outcome first.")).toBeVisible()
    expect(screen.getByRole("region", { name: "Guide for Build" })).toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: "Open step Build" }))
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true")
      expect(globalThis.document.querySelector('[data-step-id="01"]')).toHaveAttribute("aria-pressed", "true")
    })
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it("renders an older plan as its original Markdown without the legacy workspace", () => {
    render(<PlanReview plan={legacyPlan} />)

    expect(
      screen.getByRole("article", { name: "Legacy plan markdown" })
    ).toBeTruthy()
    expect(
      screen.getByRole("heading", { name: "Stored legacy plan" })
    ).toBeTruthy()
    expect(screen.getByText("Markdown output")).toBeTruthy()
    expect(screen.queryByText("Legacy step")).toBeNull()
    expect(screen.queryByText("This must not render.")).toBeNull()
    expect(screen.queryByText(/No plan yet/)).toBeNull()
    expect(screen.queryByLabelText("Resize step list")).toBeNull()
    expect(screen.queryByLabelText("Resize changes")).toBeNull()
  })
})
