// @vitest-environment jsdom
import type { PlanDocument } from "@jingler/core"
import { jinglerDark, toTokens } from "@jingler/themes"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAssetProvider } from "../asset/open-asset-context.js"
import { ThemeProvider } from "../theme-provider.js"
import { PlanReview, planFeedbackMarkdown } from "./plan-review.js"

const mermaidRender = vi.fn(async () => ({ svg: '<svg data-testid="stage-diagram"></svg>' }))
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: () => mermaidRender() } }))

const patch = [
  "@@ -1 +1 @@",
  '-export const tokenFormat = "v1"',
  '+export const tokenFormat = "v2"'
].join("\n")

const document: PlanDocument = {
  id: "plannotator:PLAN.md",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 1,
  reviewId: "review-1",
  status: "proposed",
  plan: {
    title: "Auth replacement",
    sections: [
      { id: "context", title: "Context", blocks: [{ kind: "prose", id: "c1", text: "Replace the auth flow." }] },
      { id: "test-strategy", title: "Test strategy", blocks: [{ kind: "prose", id: "t1", text: "Unit tests cover the token format." }] }
    ],
    stages: [{
      id: "implement-auth",
      title: "Implement auth",
      intent: "Implement the auth change.",
      approach: ["Replace the token format"],
      tasks: [{ id: "task-1", text: "Implement the auth change", status: "pending" }],
      files: [{ path: "src/auth.ts", change: "M" }],
      diagrams: [{ id: "d1", source: "flowchart LR\n  A --> B" }],
      notes: [{ kind: "change", id: "ch1", path: "src/auth.ts", patch }],
      acceptance: [{
        id: "a1",
        text: "Auth implementation passes",
        testReferences: [{ path: "src/auth.test.ts", cases: ["implements auth"], kind: "e2e" }],
        status: "pending",
        evidence: null
      }]
    }],
    annotations: []
  },
  updatedAt: "2026-08-27T00:00:00.000Z",
  updatedBy: "agent"
}

const noop = class { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", noop)
  vi.stubGlobal("IntersectionObserver", noop)
  // jsdom has no layout, so Range geometry is missing; the popover only needs a position.
  Range.prototype.getBoundingClientRect = () => new DOMRect(10, 10, 50, 12)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.getSelection()?.removeAllRanges()
})

const renderReview = (props: Partial<Parameters<typeof PlanReview>[0]> = {}, open = vi.fn()) =>
  render(
    <ThemeProvider tokens={toTokens(jinglerDark)}>
      <OpenAssetProvider open={open} knownFiles={new Set(["src/auth.ts"])}>
        <PlanReview document={document} {...props} />
      </OpenAssetProvider>
    </ThemeProvider>
  )

const selectText = (text: string) => {
  const node = [...screen.getByTestId("plan-review").querySelectorAll("*")]
    .flatMap((element) => [...element.childNodes])
    .find((child): child is Text => child.nodeType === 3 && (child as Text).data.includes(text))
  if (node === undefined) throw new Error(`No text node contains ${text}`)
  const range = window.document.createRange()
  const start = node.data.indexOf(text)
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  fireEvent.mouseUp(node.parentElement!)
}

const addComment = (quote: string, body: string) => {
  selectText(quote)
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: body } })
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
}

describe("PlanReview", () => {
  it("renders stages with diffs diagrams and tests", async () => {
    const open = vi.fn()
    renderReview({}, open)

    expect(screen.getByRole("heading", { name: "Test strategy" })).toBeTruthy()
    expect(screen.getByText("Unit tests cover the token format.")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Implement auth" })).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("stage-diagram")).toBeTruthy())

    const table = screen.getByRole("table", { name: "Implement auth acceptance" })
    expect(table.textContent).toContain("e2e")
    expect(table.textContent).toContain("src/auth.test.ts::implements auth")

    expect(screen.getByRole("region", { name: "Proposed change to src/auth.ts" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Open src/auth.ts" }))
    expect(open).toHaveBeenCalledWith("src/auth.ts")
  })

  it("serializes annotations into deny feedback", async () => {
    const onRevise = vi.fn()
    const onApprove = vi.fn()
    renderReview({ onRevise, onApprove })

    addComment("Implement the auth change.", "Keep the existing token format.")
    fireEvent.change(screen.getByRole("textbox", { name: "General feedback" }), {
      target: { value: "Otherwise fine." }
    })
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }))

    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1))
    const feedback = onRevise.mock.calls[0]?.[0] as string
    expect(feedback).toContain("## 1. Implement auth (implement-auth)")
    expect(feedback).toContain("> Implement the auth change.")
    expect(feedback).toContain("Keep the existing token format.")
    expect(feedback).toContain("## General\nOtherwise fine.")
    expect(onApprove).not.toHaveBeenCalled()
  })

  it("approves once and drops removed comments from feedback", async () => {
    const onApprove = vi.fn()
    const onRevise = vi.fn()
    renderReview({ onApprove, onRevise })

    addComment("Replace the auth flow.", "Drop this one.")
    fireEvent.click(screen.getByRole("button", { name: "Remove comment on Replace the auth flow." }))
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }))
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith(undefined))

    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1))
  })

  it("is read-only once the plan is approved", () => {
    renderReview({ document: { ...document, status: "approved" } })
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
    selectText("Replace the auth flow.")
    expect(screen.queryByRole("button", { name: "Add comment" })).toBeNull()
  })
})

describe("planFeedbackMarkdown", () => {
  it("returns undefined when the reviewer wrote nothing", () => {
    expect(planFeedbackMarkdown(document.plan, [], "  ")).toBeUndefined()
  })

  it("labels whole-plan comments and quotes multi-line anchors per line", () => {
    const feedback = planFeedbackMarkdown(
      document.plan,
      [{ id: "c1", quote: "line one\nline two", body: " Fix both. " }],
      ""
    )
    expect(feedback).toBe("# Plan Feedback\n\n## 1. Plan\n> line one\n> line two\n\nFix both.")
  })
})
