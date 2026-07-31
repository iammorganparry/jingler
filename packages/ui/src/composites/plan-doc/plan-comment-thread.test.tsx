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
    expect(within(menu).getByText("Worker · Active")).toBeTruthy()
    fireEvent.click(within(menu).getByText("worker-ui"))
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }))

    expect(onSubmit).toHaveBeenCalledWith(
      "Please ask @worker-ui",
      ["worker:plan-1:ui:1"]
    )
  })
})

describe("PlanCommentThread", () => {
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
})
