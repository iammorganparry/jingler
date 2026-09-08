import type { Message } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationView } from "./conversation-view.js"

const rendered = vi.hoisted(() => new Set<string>())
vi.mock("../composites/message-turn.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../composites/message-turn.js")>(),
  MessageTurn: ({ message }: { message: Message }) => {
    rendered.add(message.id)
    return <div data-testid={`turn-${message.id}`}>{message.id}</div>
  }
}))

const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
  id: `m${i}`, role: i % 2 ? "assistant" : "user", streaming: false,
  createdAt: "2026-07-24T10:00:00.000Z",
  parts: [{ _tag: "Text", text: `Message ${i}` }]
}))

beforeEach(() => {
  rendered.clear()
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(700)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "conversation-scroll" ? 560 : 140
  })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(560)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("initial transcript position", () => {
  it.each([false, true])("renders the newest rows directly (history arrives later: %s)", (late) => {
    const { rerender } = render(<ConversationView mode="auto" messages={late ? [] : messages} />)
    if (late) rerender(<ConversationView mode="auto" messages={messages} />)

    expect(screen.getByTestId("turn-m99")).toBeTruthy()
    expect(rendered.has("m0")).toBe(false)

    const viewport = screen.getByTestId("conversation-scroll")
    fireEvent.wheel(viewport, { deltaY: -100 })
    viewport.scrollTop = 0
    fireEvent.scroll(viewport)
    expect(screen.getByTestId("turn-m0")).toBeTruthy()
  })
})
