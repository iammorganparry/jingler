import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConversationView } from "./conversation-view.js"

afterEach(cleanup)

/**
 * The queued-message list sits between the transcript and the composer, so its
 * height comes straight out of both. Routing an adversarial review's findings
 * queues one turn PER FINDING — twenty of them pushed the composer off the
 * bottom of the window entirely, which is the regression these pin.
 */

const queued = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `message ${i}`, images: [] }))

const rows = () => screen.queryAllByText(/^message \d+$/)

describe("ConversationView — queued messages", () => {
  it("shows every message while the queue is small", () => {
    render(<ConversationView messages={[]} mode="accept-edits" queued={queued(3)} />)
    expect(rows()).toHaveLength(3)
    expect(screen.queryByText(/more queued/)).toBeNull()
  })

  it("caps a long queue at five, and says how many are hidden", () => {
    render(<ConversationView messages={[]} mode="accept-edits" queued={queued(22)} />)
    expect(rows()).toHaveLength(5)
    expect(screen.getByText("+17 more queued")).toBeDefined()
  })

  it("expands to the full queue and back", () => {
    render(<ConversationView messages={[]} mode="accept-edits" queued={queued(22)} />)
    fireEvent.click(screen.getByText("+17 more queued"))
    expect(rows()).toHaveLength(22)
    fireEvent.click(screen.getByText("Show fewer"))
    expect(rows()).toHaveLength(5)
  })

  it("keeps each row's queue INDEX while capped", () => {
    // The cap is a `slice(0, n)`, so indices survive — but `onUnqueue` addresses
    // the queue positionally, and an off-by-one here would drop the wrong
    // message with no way for the operator to tell.
    const onUnqueue = vi.fn()
    render(
      <ConversationView messages={[]} mode="accept-edits" queued={queued(22)} onUnqueue={onUnqueue} />
    )
    fireEvent.click(screen.getAllByTitle("Remove from queue")[2]!)
    expect(onUnqueue).toHaveBeenCalledWith(2)
  })

  it("addresses the right message once expanded past the cap", () => {
    const onUnqueue = vi.fn()
    render(
      <ConversationView messages={[]} mode="accept-edits" queued={queued(22)} onUnqueue={onUnqueue} />
    )
    fireEvent.click(screen.getByText("+17 more queued"))
    fireEvent.click(screen.getAllByTitle("Remove from queue")[20]!)
    expect(onUnqueue).toHaveBeenCalledWith(20)
  })

  it("hands a queued message off by its index", () => {
    const onHandoffQueued = vi.fn()
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        queued={queued(4)}
        onHandoffQueued={onHandoffQueued}
        handoffHint="Hand off — run this in a new chat on opus"
      />
    )
    // Addressed positionally like every other row action, and the tooltip names
    // the target model so "hand off" is not a leap of faith.
    fireEvent.click(screen.getAllByTitle("Hand off — run this in a new chat on opus")[2]!)
    expect(onHandoffQueued).toHaveBeenCalledWith(2)
  })

  it("edits a queued message in place and commits on Enter", () => {
    const onEditQueued = vi.fn()
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        queued={queued(3)}
        onEditQueued={onEditQueued}
      />
    )
    fireEvent.click(screen.getAllByTitle("Edit queued message")[1]!)
    const input = screen.getByLabelText("Edit queued message")
    fireEvent.change(input, { target: { value: "message 1, revised" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onEditQueued).toHaveBeenCalledWith(1, "message 1, revised")
  })

  it("abandons an edit on Escape, leaving the message as it was", () => {
    const onEditQueued = vi.fn()
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        queued={queued(2)}
        onEditQueued={onEditQueued}
      />
    )
    fireEvent.click(screen.getAllByTitle("Edit queued message")[0]!)
    const input = screen.getByLabelText("Edit queued message")
    fireEvent.change(input, { target: { value: "scrap this" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onEditQueued).not.toHaveBeenCalled()
    expect(screen.getByText("message 0")).toBeDefined()
  })

  it("emptying a text-only message removes it rather than queueing a blank turn", () => {
    const onEditQueued = vi.fn()
    const onUnqueue = vi.fn()
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        queued={queued(2)}
        onEditQueued={onEditQueued}
        onUnqueue={onUnqueue}
      />
    )
    fireEvent.click(screen.getAllByTitle("Edit queued message")[0]!)
    const input = screen.getByLabelText("Edit queued message")
    fireEvent.change(input, { target: { value: "  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onEditQueued).not.toHaveBeenCalled()
    expect(onUnqueue).toHaveBeenCalledWith(0)
  })

  it("abandons an edit when Cancel is clicked, not just on Escape", () => {
    // The input commits on blur, and clicking Cancel blurs it — so the naive
    // wiring SAVED the edit the operator was cancelling.
    const onEditQueued = vi.fn()
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        queued={queued(2)}
        onEditQueued={onEditQueued}
      />
    )
    fireEvent.click(screen.getAllByTitle("Edit queued message")[0]!)
    const input = screen.getByLabelText("Edit queued message")
    fireEvent.change(input, { target: { value: "scrap this" } })
    fireEvent.mouseDown(screen.getByTitle("Cancel edit"))
    expect(onEditQueued).not.toHaveBeenCalled()
    expect(screen.getByText("message 0")).toBeDefined()
  })

  it("only offers Send now while the agent is actually busy", () => {
    const onSendNow = vi.fn()
    const props = { messages: [], mode: "accept-edits" as const, queued: queued(2), onSendNow }
    const { rerender } = render(<ConversationView {...props} busy={false} />)
    expect(screen.queryByTitle(/^Send now/)).toBeNull()
    rerender(<ConversationView {...props} busy />)
    fireEvent.click(screen.getAllByTitle(/^Send now/)[1]!)
    expect(onSendNow).toHaveBeenCalledWith(1)
  })
})
