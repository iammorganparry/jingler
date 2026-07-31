// @vitest-environment jsdom
import type { Plan, PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
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
  it("keeps a streamed plan read-only and promotes it on the same editor instance", async () => {
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

    const editor = await screen.findByLabelText("Plan document")
    expect(editor.getAttribute("contenteditable")).toBe("false")
    expect(screen.getByRole("status").textContent).toContain("Composing")
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Revise/ })).toBeNull()

    view.rerender(<PlanReview plan={canonicalPlan} />)
    expect(screen.getByLabelText("Plan document")).toBe(editor)
    expect(screen.getByRole("status").textContent).toContain("Loading revision")

    view.rerender(
      <PlanReview
        plan={canonicalPlan}
        document={{
          ...document,
          id: "plan-stream",
          source: source.replace("Editor-only plan", "Canonical editor plan")
        }}
      />
    )
    expect(screen.getByLabelText("Plan document")).toBe(editor)
    expect(screen.getByRole("status").textContent).toContain("Synced")
    expect(screen.getByText("PRD: Canonical editor plan")).toBeTruthy()
    expect(screen.getByText("revision 2")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy()
  })

  it("scrolls a progress-dock deep link to its stable stage id", async () => {
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
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start"
    })
    expect(onSelectStep).toHaveBeenCalledWith("01")
  })

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

  it("shows worker identity and isolates stop/retry controls to that worker", async () => {
    const onStopWorker = vi.fn()
    const onRetryWorker = vi.fn()
    const workerSource = source.replace(
      '<section data-stage="01" data-title="Build">',
      `<section data-stage="01" data-title="Build" data-depends-on="" data-complexity="high">
<div data-assignment data-agent-id="worker-a" data-cli="codex" data-model="gpt-5.6-sol" data-reason="High complexity route." data-status="running"></div>`
    )
    const workerDocument: PlanDocument = {
      ...document,
      source: workerSource,
      projection: {
        ...document.projection,
        stages: document.projection.stages.map((stage) => ({
          ...stage,
          dependencies: [],
          complexity: "high" as const,
          assignment: {
            agentId: "worker-a",
            cli: "codex" as const,
            model: "gpt-5.6-sol",
            reason: "High complexity route."
          },
          executionStatus: "running" as const
        }))
      }
    }

    const view = render(
      <PlanReview
        plan={null}
        document={workerDocument}
        onStopWorker={onStopWorker}
        onRetryWorker={onRetryWorker}
      />
    )
    expect(await screen.findByText("codex · gpt-5.6-sol")).toBeTruthy()
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop worker worker-a" })
    )
    expect(onStopWorker).toHaveBeenCalledWith("worker-a")

    view.rerender(
      <PlanReview
        plan={null}
        document={{
          ...workerDocument,
          source: workerSource.replace(
            'data-status="running"',
            'data-status="blocked"'
          )
        }}
        onStopWorker={onStopWorker}
        onRetryWorker={onRetryWorker}
      />
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry worker worker-a" })
    )
    expect(onRetryWorker).toHaveBeenCalledWith("worker-a")
  })
})
