// @vitest-environment jsdom
import type { Plan, PlanDocument } from "@jingler/core"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { PlanReview } from "./plan-review.js"

const source = `<h1>PRD: Editor-only plan</h1>
<section data-stage="01" data-title="Build">
<h3>Intent</h3><p>Use one document editor.</p>
<div data-acceptance="01.1" data-status="pending">Legacy rails are absent.</div>
</section>`

const document: PlanDocument = {
  id: "plan-1",
  sessionId: "s1",
  producingChatId: "c1",
  revision: 2,
  status: "proposed",
  source,
  projection: {
    title: "PRD: Editor-only plan",
    sections: [],
    stages: [
      {
        id: "01",
        title: "Build",
        intent: "Use one document editor.",
        markdown: "",
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
  it("renders only the canonical Notion-style editor when a document exists", () => {
    render(<PlanReview plan={legacyPlan} document={document} />)

    expect(screen.getByLabelText("Plan document")).toBeTruthy()
    expect(screen.getByText("PRD: Editor-only plan")).toBeTruthy()
    expect(screen.queryByLabelText("Resize step list")).toBeNull()
    expect(screen.queryByLabelText("Resize changes")).toBeNull()
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
