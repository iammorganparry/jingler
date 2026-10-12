import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { QueuedMessageRow } from "./queued-message-row.js"

afterEach(cleanup)

describe("QueuedMessageRow", () => {
  it("fires onSendNow when the send now button is clicked", () => {
    const onSendNow = vi.fn()
    render(
      <QueuedMessageRow
        text="test message"
        images={0}
        onSendNow={onSendNow}
        onHandoff={() => {}}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    fireEvent.click(screen.getByLabelText("Send now — steer the agent immediately"))
    expect(onSendNow).toHaveBeenCalledTimes(1)
  })

  it("fires onHandoff when the handoff button is clicked", () => {
    const onHandoff = vi.fn()
    render(
      <QueuedMessageRow
        text="test message"
        images={0}
        onSendNow={() => {}}
        onHandoff={onHandoff}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    fireEvent.click(screen.getByLabelText("Hand off — run this in a new chat"))
    expect(onHandoff).toHaveBeenCalledTimes(1)
  })

  it("fires onEdit when edit is committed", () => {
    const onEdit = vi.fn()
    render(
      <QueuedMessageRow
        text="test message"
        images={0}
        onSendNow={() => {}}
        onHandoff={() => {}}
        onEdit={onEdit}
        onRemove={() => {}}
      />
    )
    fireEvent.click(screen.getByLabelText("Edit queued message"))
    const input = screen.getByLabelText("Edit queued message")
    fireEvent.change(input, { target: { value: "updated message" } })
    fireEvent.click(screen.getByLabelText("Save edit"))
    expect(onEdit).toHaveBeenCalledWith("updated message")
  })

  it("fires onRemove when the remove button is clicked", () => {
    const onRemove = vi.fn()
    render(
      <QueuedMessageRow
        text="test message"
        images={0}
        onSendNow={() => {}}
        onHandoff={() => {}}
        onEdit={() => {}}
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByLabelText("Remove from queue"))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it("hides all actions when sending is true", () => {
    render(
      <QueuedMessageRow
        text="test message"
        images={0}
        sending
        onSendNow={() => {}}
        onHandoff={() => {}}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    expect(screen.queryByLabelText("Send now — steer the agent immediately")).toBeNull()
    expect(screen.queryByLabelText("Hand off — run this in a new chat")).toBeNull()
    expect(screen.queryByLabelText("Edit queued message")).toBeNull()
    expect(screen.queryByLabelText("Remove from queue")).toBeNull()
  })

  it("uses handoffHint for the tooltip when provided", () => {
    render(
      <QueuedMessageRow
        text="test message"
        images={0}
        onHandoff={() => {}}
        handoffHint="Hand off to Claude 3.7 Sonnet"
      />
    )
    expect(screen.getByLabelText("Hand off to Claude 3.7 Sonnet")).toBeTruthy()
  })
})
