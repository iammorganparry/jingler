// @vitest-environment jsdom
import type { Message } from "@jingler/core"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MessageTurn } from "./message-turn.js"

afterEach(cleanup)

const assistant = (overrides: Partial<Message> = {}): Message => ({
  id: "assistant-stream",
  role: "assistant",
  streaming: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  parts: [
    { _tag: "Text", text: "Earlier settled paragraph." },
    { _tag: "Text", text: "The active **Markdown** tail" }
  ],
  ...overrides
})

describe("MessageTurn streaming text", () => {
  it("marks only the last active assistant text part", () => {
    const view = render(<MessageTurn message={assistant()} />)
    const streaming = view.container.querySelectorAll(".jingler-streaming-text")
    expect(streaming).toHaveLength(1)
    expect(streaming[0]?.textContent).toContain("The active Markdown tail")
    expect(view.container.textContent).toContain("Earlier settled paragraph")
  })

  it("inserts transcript-owned content after its exact part", () => {
    const view = render(<MessageTurn
      message={assistant({
        streaming: false,
        parts: [
          { _tag: "Text", text: "Before tool." },
          { _tag: "Text", text: "Plan tool." },
          { _tag: "Text", text: "After tool." }
        ]
      })}
      afterPart={{ index: 1, content: <div>Plan widget.</div> }}
    />)
    const text = view.container.textContent ?? ""
    expect(text.indexOf("Plan tool.")).toBeLessThan(text.indexOf("Plan widget."))
    expect(text.indexOf("Plan widget.")).toBeLessThan(text.indexOf("After tool."))
  })

  it("does not mark completed messages or a text part followed by another part", () => {
    const completed = render(<MessageTurn message={assistant({ streaming: false })} />)
    expect(completed.container.querySelector(".jingler-streaming-text")).toBeNull()
    completed.unmount()

    const withProgress = render(<MessageTurn message={assistant({
      parts: [
        { _tag: "Text", text: "Text before progress." },
        { _tag: "PlanTaskProgress", stageId: "stage-1", taskId: "task-1", status: "in-progress" }
      ]
    })} />)
    expect(withProgress.container.querySelector(".jingler-streaming-text")).toBeNull()
  })
})
