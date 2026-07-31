// @vitest-environment jsdom
import type { PlanCommentMessage, PlanParticipant } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PlanCommentComposer,
  PlanCommentThread,
  PlanCommentThreadControlsProvider
} from "./plan-comment-thread.js"

const participants: ReadonlyArray<PlanParticipant> = [
  {
    routingId: "orchestrator:chat-1",
    displayName: "Jingler",
    role: "orchestrator",
    lifecycle: "parked",
    ownerRoutingId: null
  },
  {
    routingId: "worker:plan-1:ui:1",
    displayName: "worker-ui",
    role: "worker",
    lifecycle: "running",
    ownerRoutingId: null
  },
  {
    routingId: "worker:plan-1:api:2",
    displayName: "worker-api",
    role: "worker",
    lifecycle: "running",
    ownerRoutingId: null
  },
  {
    routingId: "subagent:worker:plan-1:ui:1:explore-a",
    displayName: "Explore",
    role: "subagent",
    lifecycle: "running",
    ownerRoutingId: "worker:plan-1:ui:1"
  },
  {
    routingId: "subagent:worker:plan-1:api:2:explore-b",
    displayName: "Explore",
    role: "subagent",
    lifecycle: "running",
    ownerRoutingId: "worker:plan-1:api:2"
  }
]

const messages: ReadonlyArray<PlanCommentMessage> = [
  {
    id: "m-user",
    body: "Can you verify this?",
    authorKind: "user",
    authorId: "operator",
    createdAt: "2026-07-31T08:00:00.000Z",
    mentionedParticipantIds: ["worker:plan-1:ui:1"],
    deliveryState: "failed"
  },
  {
    id: "m-agent",
    body: "I checked the implementation.",
    authorKind: "agent",
    authorId: "worker:plan-1:ui:1",
    createdAt: "2026-07-31T08:01:00.000Z",
    mentionedParticipantIds: [],
    deliveryState: "sent"
  }
]

afterEach(cleanup)

describe("PlanCommentComposer", () => {
  it("lists active participants with role context and preserves the routing id", () => {
    const onSubmit = vi.fn()
    render(
      <PlanCommentComposer participants={participants} onSubmit={onSubmit} />
    )
    const input = screen.getByLabelText("Reply to this thread…")
    fireEvent.change(input, { target: { value: "Please ask @" } })

    const menu = screen.getByRole("listbox", { name: "Mention an agent" })
    expect(within(menu).getByText("Orchestrator · Parked")).toBeTruthy()
    expect(within(menu).getAllByText("Worker · Active")).toHaveLength(2)
    fireEvent.click(within(menu).getByText("worker-ui"))
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }))

    expect(onSubmit).toHaveBeenCalledWith(
      "Please ask @worker-ui",
      ["worker:plan-1:ui:1"]
    )
  })

  it("does not submit a routing target after its visible mention is removed", () => {
    const onSubmit = vi.fn()
    render(
      <PlanCommentComposer participants={participants} onSubmit={onSubmit} />
    )
    const input = screen.getByLabelText("Reply to this thread…")
    fireEvent.change(input, { target: { value: "Ask @work" } })
    fireEvent.click(screen.getByText("worker-ui"))
    fireEvent.change(input, { target: { value: "No agent needed" } })
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }))

    expect(onSubmit).toHaveBeenCalledWith("No agent needed", [])
  })

  it("distinguishes same-named subagents by owner, attempt, and route identity", () => {
    render(
      <PlanCommentComposer participants={participants} onSubmit={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText("Reply to this thread…"), {
      target: { value: "Ask @Explore" }
    })

    const menu = screen.getByRole("listbox", { name: "Mention an agent" })
    expect(
      within(menu).getByText("Sub-agent · Active · worker-ui · attempt 1 · explore-a")
    ).toBeTruthy()
    expect(
      within(menu).getByText("Sub-agent · Active · worker-api · attempt 2 · explore-b")
    ).toBeTruthy()
  })

  it("preserves the draft when submission reports a failure", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false)
    render(
      <PlanCommentComposer participants={participants} onSubmit={onSubmit} />
    )
    const input = screen.getByLabelText("Reply to this thread…")
    fireEvent.change(input, { target: { value: "Please keep this draft" } })
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect((input as HTMLTextAreaElement).value).toBe("Please keep this draft")
  })
})

describe("PlanCommentThread", () => {
  it("waits for the containing plan revision before mutating a new thread", () => {
    const onSetResolved = vi.fn()
    const view = (disabled: boolean) => (
      <PlanCommentThreadControlsProvider
        controls={{ participants, disabled, onSetResolved }}
      >
        <PlanCommentThread annotationId="a1" status="open" messages={messages} />
      </PlanCommentThreadControlsProvider>
    )
    const { rerender } = render(view(true))
    const resolve = screen.getByRole("button", { name: "Resolve" })

    expect((resolve as HTMLButtonElement).disabled).toBe(true)
    rerender(view(false))
    fireEvent.click(resolve)

    expect(onSetResolved).toHaveBeenCalledWith("a1", true)
  })

  it("keeps ordered replies together and exposes retry and resolve", async () => {
    const onRetry = vi.fn()
    const onSetResolved = vi.fn()
    render(
      <PlanCommentThreadControlsProvider
        controls={{ participants, onRetry, onSetResolved }}
      >
        <PlanCommentThread annotationId="a1" status="open" messages={messages} />
      </PlanCommentThreadControlsProvider>
    )

    const items = screen.getAllByRole("listitem")
    expect(items[0]?.textContent).toContain("Can you verify this?")
    expect(items[1]?.textContent).toContain("I checked the implementation.")
    expect(screen.getByText("Delivery failed")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry delivery" }))
    expect(onRetry).toHaveBeenCalledWith("a1", messages[0])
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Resolve" }).hasAttribute("disabled")
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }))
    expect(onSetResolved).toHaveBeenCalledWith("a1", true)
  })

  it("reopens a resolved thread", () => {
    const onSetResolved = vi.fn()
    render(
      <PlanCommentThreadControlsProvider controls={{ participants, onSetResolved }}>
        <PlanCommentThread annotationId="a1" status="resolved" messages={messages} />
      </PlanCommentThreadControlsProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }))
    expect(onSetResolved).toHaveBeenCalledWith("a1", false)
  })

  it("keeps a failed reply in the composer and shows the error", async () => {
    const onReply = vi.fn().mockRejectedValue(new Error("Revision changed"))
    render(
      <PlanCommentThreadControlsProvider controls={{ participants, onReply }}>
        <PlanCommentThread annotationId="a1" status="open" messages={messages} />
      </PlanCommentThreadControlsProvider>
    )
    const input = screen.getByLabelText("Reply to this thread…")
    fireEvent.change(input, { target: { value: "Do not erase me" } })
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }))

    expect((await screen.findByRole("alert")).textContent).toContain("Revision changed")
    expect((input as HTMLTextAreaElement).value).toBe("Do not erase me")
  })
})
