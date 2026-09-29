// @vitest-environment jsdom
import type { PlanAnnotation, PlanDocument } from "@jingler/core"
import { jinglerDark, toTokens } from "@jingler/themes"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAssetProvider } from "../asset/open-asset-context.js"
import { ThemeProvider } from "../theme-provider.js"
import { loadPlanComments } from "../composites/plan-comment-store.js"
import { PlanReview, planFeedbackMarkdown } from "./plan-review.js"

const mermaidRender = vi.fn(async () => ({ svg: '<svg data-testid="stage-diagram"></svg>' }))
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: () => mermaidRender() } }))

const REPLY_TEXTBOX = /Reply to/
const REVISION_BUTTON = /Changes since revision/

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
      deliverable: "Returning users can authenticate with the replacement token format.",
      userStory: {
        article: "an",
        role: "authenticated user",
        capability: "sign in with my existing session",
        benefit: "I can continue my work without interruption"
      },
      definitionOfDone: ["Acceptance criteria verified", "Focused tests and typecheck pass"],
      approach: ["Replace the token format"],
      tasks: [{ id: "task-1", text: "Implement the auth change", status: "pending" }],
      files: [{ path: "src/auth.ts", change: "M" }],
      diagrams: [{ id: "d1", source: "flowchart LR\n  A --> B" }],
      notes: [{ kind: "change", id: "ch1", path: "src/auth.ts", patch }],
      complexity: "medium",
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
  localStorage.clear()
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
  it("renders a compact stage summary and discloses technical detail on demand", async () => {
    const open = vi.fn()
    renderReview({}, open)

    expect(screen.getByRole("heading", { name: "Test strategy" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Implement auth" })).toBeTruthy()
    expect(screen.getByText("Returning users can authenticate with the replacement token format.")).toBeTruthy()
    expect(screen.getByRole("region", { name: "Implement auth user story" }).textContent)
      .toContain("As an authenticated user")
    expect(screen.getByRole("region", { name: "Implement auth user story" }).textContent)
      .toContain("sign in with my existing session")
    expect(screen.getByRole("region", { name: "Implement auth definition of done" }).textContent)
      .toContain("Focused tests and typecheck pass")
    expect(screen.getByRole("region", { name: "Implement auth tasks" }).textContent).toContain("Implement the auth change")
    expect(screen.getByRole("region", { name: "Implement auth files" }).textContent).toContain("src/auth.ts")
    expect(screen.getByRole("region", { name: "Implement auth acceptance criteria" }).textContent).toContain("e2e · src/auth.test.ts::implements auth")
    expect(screen.getByText("medium", { exact: false })).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("stage-diagram")).toBeTruthy())

    const disclosure = screen.getByText("Technical details").closest("details")
    expect(disclosure?.hasAttribute("open")).toBe(false)
    fireEvent.click(screen.getByText("Technical details"))
    expect(disclosure?.hasAttribute("open")).toBe(true)
    expect(screen.getByRole("region", { name: "Proposed change to src/auth.ts" })).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: "Open src/auth.ts" })[0]!)
    expect(open).toHaveBeenCalledWith("src/auth.ts")
  })

  it("adds a comment to a whole stage", () => {
    renderReview()
    fireEvent.click(screen.getByRole("button", { name: "Comment on Implement auth" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Keep this stage small." } })
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    expect(screen.getByText("Keep this stage small.")).toBeTruthy()
    expect(screen.getByRole("complementary", { name: "Plan comments" }).textContent).toContain("implement-auth")
  })

  it("serializes annotations into deny feedback", async () => {
    const onRevise = vi.fn()
    const onApprove = vi.fn()
    renderReview({ onRevise, onApprove })

    addComment("Returning users can authenticate with the replacement token format.", "Keep the existing token format.")
    fireEvent.change(screen.getByRole("textbox", { name: "General feedback" }), {
      target: { value: "Otherwise fine." }
    })
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }))

    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(1))
    const feedback = onRevise.mock.calls[0]?.[0] as string
    expect(feedback).toContain("## 1. Implement auth (implement-auth)")
    expect(feedback).toContain("> Returning users can authenticate with the replacement token format.")
    expect(feedback).toContain("Keep the existing token format.")
    expect(feedback).toContain("## General\nOtherwise fine.")
    expect(onApprove).not.toHaveBeenCalled()
  })

  it("approves once and excludes resolved comments from feedback", async () => {
    const onApprove = vi.fn()
    const onRevise = vi.fn()
    renderReview({ onApprove, onRevise })

    addComment("Replace the auth flow.", "Resolved note.")
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }))
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }))
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith(undefined))

    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1))
  })

  it("persists replies and resolution across remounts", async () => {
    const first = renderReview()
    addComment("Returning users can authenticate with the replacement token format.", "Keep this behavior.")
    const reply = screen.getByRole("textbox", { name: REPLY_TEXTBOX })
    fireEvent.change(reply, { target: { value: "Agreed." } })
    fireEvent.click(screen.getByRole("button", { name: "Reply" }))
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy())
    first.unmount()

    renderReview()
    expect(screen.getByText("Keep this behavior.")).toBeTruthy()
    expect(screen.getByText("Agreed.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy()
  })

  it("isolates persisted comments by session and plan identity", async () => {
    const first = renderReview()
    addComment("Returning users can authenticate with the replacement token format.", "Only session one.")
    await waitFor(() => expect(loadPlanComments("session-1:chat-1:plannotator:PLAN.md")).toHaveLength(1))

    const other = { ...document, sessionId: "session-2" }
    first.rerender(
      <ThemeProvider tokens={toTokens(jinglerDark)}>
        <OpenAssetProvider open={vi.fn()} knownFiles={new Set(["src/auth.ts"])}>
          <PlanReview document={other} />
        </OpenAssetProvider>
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.queryByText("Only session one.")).toBeNull())
    expect(loadPlanComments("session-2:chat-1:plannotator:PLAN.md")).toEqual([])
  })

  it("reanchors selection comments and reports detached anchors after a revision", async () => {
    const first = renderReview()
    addComment("Returning users can authenticate with the replacement token format.", "Keep this behavior.")
    await waitFor(() => expect(globalThis.document.querySelector("[data-comment-highlight]")).toBeTruthy())
    await waitFor(() => expect(loadPlanComments("session-1:chat-1:plannotator:PLAN.md")).toHaveLength(1))
    first.unmount()
    localStorage.clear()
    const detached: PlanAnnotation = {
      id: "detached", stageId: "implement-auth", body: "Old note", author: "user",
      createdAt: "2026-09-29T00:00:00.000Z", status: "open",
      anchor: { quote: "Text removed by revision.", prefix: "", suffix: "" },
      messages: [{ id: "m", body: "Old note", authorKind: "user", authorId: "operator", createdAt: "2026-09-29T00:00:00.000Z", mentionedParticipantIds: [], deliveryState: "sent" }]
    }
    renderReview({ document: { ...document, id: "plannotator:revised", revision: 2, plan: { ...document.plan, annotations: [detached] } } })
    await waitFor(() => expect(screen.getByText("Detached from changed text")).toBeTruthy())
  })

  it("shows a failed decision and keeps comments for a retry", async () => {
    const onRevise = vi.fn().mockRejectedValueOnce(new Error("Review is stale.")).mockResolvedValueOnce(undefined)
    renderReview({ onRevise })

    addComment("Returning users can authenticate with the replacement token format.", "Keep the token format.")
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Review is stale.")
    expect(screen.getByRole("button", { name: "Request changes" }).hasAttribute("disabled")).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Request changes" }))
    await waitFor(() => expect(onRevise).toHaveBeenCalledTimes(2))
    expect(onRevise.mock.calls[1]?.[0]).toContain("Keep the token format.")
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("shows revision diff after resubmission", async () => {
    const first = renderReview({ document: { ...document, sourceMarkdown: "# Auth\n- keep\n" } })
    expect(screen.queryByRole("button", { name: REVISION_BUTTON })).toBeNull()
    first.unmount()

    renderReview({
      document: {
        ...document,
        revision: 2,
        sourceMarkdown: "# Auth\n- keep the token format\n",
        previousSourceMarkdown: "# Auth\n- replace the token format\n"
      }
    })
    expect(screen.queryByRole("region", { name: "Changes since the previous revision" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Changes since revision 1" }))
    const diff = await screen.findByRole("region", { name: "Changes since the previous revision" })
    await waitFor(() => {
      const text = diff.querySelector("diffs-container")?.shadowRoot?.textContent ?? diff.textContent ?? ""
      expect(text).toContain("keep the token format")
      expect(text).toContain("replace the token format")
    })
    fireEvent.click(screen.getByRole("button", { name: "Hide changes" }))
    expect(screen.queryByRole("region", { name: "Changes since the previous revision" })).toBeNull()
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
      [{ quote: "line one\nline two", body: " Fix both. " }],
      ""
    )
    expect(feedback).toBe("# Plan Feedback\n\n## 1. Plan\n> line one\n> line two\n\nFix both.")
  })
})
