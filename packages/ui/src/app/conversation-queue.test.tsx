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

// Ids, not positions, are how every row action addresses its message — the queue
// removes its own head mid-run, so an index is stale the moment it is captured.
const queued = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `q${i}`, text: `message ${i}`, images: [] }))

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

  it("addresses the right message while the list is capped", () => {
    // The cap is a `slice(0, n)`, so the visible rows are the first n — and each
    // reports its OWN id. Reporting a position instead would drop the wrong
    // message with no way for the operator to tell.
    const onUnqueue = vi.fn()
    render(
      <ConversationView messages={[]} mode="accept-edits" queued={queued(22)} onUnqueue={onUnqueue} />
    )
    fireEvent.click(screen.getAllByTitle("Remove from queue")[2]!)
    expect(onUnqueue).toHaveBeenCalledWith("q2")
  })

  it("addresses the right message once expanded past the cap", () => {
    const onUnqueue = vi.fn()
    render(
      <ConversationView messages={[]} mode="accept-edits" queued={queued(22)} onUnqueue={onUnqueue} />
    )
    fireEvent.click(screen.getByText("+17 more queued"))
    fireEvent.click(screen.getAllByTitle("Remove from queue")[20]!)
    expect(onUnqueue).toHaveBeenCalledWith("q20")
  })

  it("hands a queued message off by its id", () => {
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
    // Addressed by id like every other row action, and the tooltip names the
    // target model so "hand off" is not a leap of faith.
    fireEvent.click(screen.getAllByTitle("Hand off — run this in a new chat on opus")[2]!)
    expect(onHandoffQueued).toHaveBeenCalledWith("q2")
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
    expect(onEditQueued).toHaveBeenCalledWith("q1", "message 1, revised")
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
    expect(onUnqueue).toHaveBeenCalledWith("q0")
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

  it("keeps an in-progress edit when the queue flushes its head", () => {
    // The queue mutates itself now: the head goes to the running turn at each tool
    // boundary, at a moment the operator did not cause and cannot predict. With
    // positional keys every row below it remounts, which threw away text someone
    // was part-way through typing.
    const props = { messages: [], mode: "accept-edits" as const, onEditQueued: vi.fn() }
    const { rerender } = render(<ConversationView {...props} queued={queued(3)} />)
    fireEvent.click(screen.getAllByTitle("Edit queued message")[1]!)
    fireEvent.change(screen.getByLabelText("Edit queued message"), {
      target: { value: "half-typed correction" }
    })

    rerender(<ConversationView {...props} queued={queued(3).slice(1)} />)

    expect(screen.getByLabelText("Edit queued message")).toHaveProperty(
      "value",
      "half-typed correction"
    )
  })

  it("cancels from the keyboard, where there is no mousedown to intercept", () => {
    // Tab moves focus input → Save → Cancel. Committing on the input's blur made
    // both buttons unreachable that way: the row left edit mode before either
    // could fire, so a keyboard-only operator reaching for the visible Cancel
    // control SAVED the edit instead, with Escape the only working way out.
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

    // Tabbing to Cancel must not commit on the way.
    const cancel = screen.getByTitle("Cancel edit")
    fireEvent.blur(input, { relatedTarget: cancel })
    expect(onEditQueued).not.toHaveBeenCalled()

    // Enter/Space on the focused button arrives as a click, never a mousedown.
    fireEvent.click(cancel)
    expect(onEditQueued).not.toHaveBeenCalled()
    expect(screen.getByText("message 0")).toBeDefined()
  })

  it("commits when focus leaves the row entirely", () => {
    // The counterpart: suppressing the commit for intra-row focus must not turn
    // a genuine click-away into a lost edit.
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
    fireEvent.change(input, { target: { value: "message 0, revised" } })
    fireEvent.blur(input, { relatedTarget: document.body })
    expect(onEditQueued).toHaveBeenCalledWith("q0", "message 0, revised")
  })

  it("withholds every action from the message being handed to the live turn", () => {
    // It is still listed — nothing is confirmed until the harness replies — but
    // the agent already HAS this text. Handing it off would start the same prompt
    // again in a fresh chat; removing or editing it would act on a message that
    // has already gone.
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        busy
        queued={queued(3)}
        steeringId="q0"
        onUnqueue={vi.fn()}
        onSendNow={vi.fn()}
        onEditQueued={vi.fn()}
        onHandoffQueued={vi.fn()}
      />
    )
    expect(screen.getByText("Sending")).toBeDefined()
    // Two rows still act; the one in flight does not.
    expect(screen.getAllByTitle("Remove from queue")).toHaveLength(2)
    expect(screen.getAllByTitle("Edit queued message")).toHaveLength(2)
    expect(screen.getAllByTitle(/^Hand off/)).toHaveLength(2)
    expect(screen.getAllByTitle(/^Send now/)).toHaveLength(2)
  })

  it("only offers Send now while the agent is actually busy", () => {
    const onSendNow = vi.fn()
    const props = { messages: [], mode: "accept-edits" as const, queued: queued(2), onSendNow }
    const { rerender } = render(<ConversationView {...props} busy={false} />)
    expect(screen.queryByTitle(/^Send now/)).toBeNull()
    rerender(<ConversationView {...props} busy />)
    fireEvent.click(screen.getAllByTitle(/^Send now/)[1]!)
    expect(onSendNow).toHaveBeenCalledWith("q1")
  })
})
