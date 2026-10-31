// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { plannotatorProjectionToPlanDocument, type Message } from "@jingler/core"
import {
  ConversationView,
  isRetryablePromptFailure,
  latestAssistantMessageIndex,
  planTranscriptAnchorIndex
} from "./conversation-view.js"

afterEach(cleanup)

const textMessage = (id: string, role: Message["role"], text: string): Message => ({
  id,
  role,
  streaming: false,
  createdAt: `2026-08-13T00:00:0${id}.000Z`,
  parts: [{ _tag: "Text", text }]
})

describe("ConversationView prompt recovery", () => {
  it("offers recovery only for the latest failed Pi prompt", () => {
    const prompt = textMessage("1", "user", "Try this again")
    const failed = textMessage("2", "assistant", "pi prompt failed: Provider is not configured")

    expect(isRetryablePromptFailure([prompt, failed], 1)).toBe(true)
    expect(isRetryablePromptFailure([prompt, failed, textMessage("3", "user", "newer")], 1)).toBe(false)
  })
})

describe("ConversationView message navigation", () => {
  it("anchors each new assistant message", async () => {
    const scrollTo = vi.fn()
    const originalScrollTo = HTMLElement.prototype.scrollTo
    HTMLElement.prototype.scrollTo = scrollTo
    try {
      const messages = [
        textMessage("1", "user", "First request"),
        textMessage("2", "assistant", "Earlier response")
      ]
      const view = render(<ConversationView mode="auto" messages={messages} />)
      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
      scrollTo.mockClear()

      const nextMessages = [
        ...messages,
        textMessage("3", "user", "Second request"),
        textMessage("4", "assistant", "Latest response")
      ]
      view.rerender(<ConversationView mode="auto" messages={nextMessages} />)

      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
      expect(latestAssistantMessageIndex(nextMessages)).toBe(3)
      expect(screen.queryByTestId("conversation-runway")).toBeNull()
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo
    }
  })
})

describe("ConversationView Plannotator projection", () => {
  it("does not render a transcript card for an empty projection", () => {
    const document = plannotatorProjectionToPlanDocument(
      {
        phase: "idle",
        planFilePath: null,
        review: null,
        checklist: []
      },
      "session-1",
      "chat-1",
      "2026-08-13T00:00:00.000Z"
    )

    render(
      <ConversationView
        messages={[]}
        mode="auto"
        planDocument={document}
      />
    )

    expect(screen.queryByTestId("plannotator-transcript-card")).toBeNull()
  })

  it("does not append an active plan when its plan-tool turn is not loaded", () => {
    const document = plannotatorProjectionToPlanDocument(
      {
        phase: "executing",
        planFilePath: "/tmp/plan.md",
        review: null,
        checklist: [{ step: 1, text: "Inspect the runtime", completed: true }]
      },
      "session-1",
      "chat-1",
      "2026-08-13T00:00:00.000Z"
    )

    render(<ConversationView messages={[]} mode="plan" planDocument={document} />)

    expect(screen.queryByTestId("plannotator-transcript-card")).toBeNull()
  })

  it("anchors to the latest non-failed plan creation or revision tool turn", () => {
    const message = (
      id: string,
      toolName?: string,
      status: "running" | "success" | "error" = "success"
    ): Message => ({
      id,
      role: "assistant",
      streaming: false,
      createdAt: `2026-08-13T00:00:0${id}.000Z`,
      parts: toolName === undefined ? [] : [{
        _tag: "Tool",
        tool: {
          id: `tool-${id}`,
          name: toolName,
          target: "PLAN.md",
          status,
          meta: null,
          diff: null,
          preview: null
        }
      }]
    })

    expect(planTranscriptAnchorIndex([
      message("1", "plannotator_submit_plan"),
      message("2", "plannotator_update_plan", "error"),
      message("3", "plannotator_update_plan", "running")
    ])).toBe(0)
    expect(planTranscriptAnchorIndex([
      message("1", "plannotator_submit_plan"),
      message("2", "plannotator_submit_plan", "running")
    ])).toBe(1)
  })
})

describe("ConversationView preview chip", () => {
  it("offers Preview ready · Open browser only when a preview was revealed", () => {
    const onOpen = vi.fn()
    const view = render(<ConversationView mode="auto" messages={[]} />)
    expect(screen.queryByTestId("preview-ready-chip")).toBeNull()
    view.rerender(<ConversationView mode="auto" messages={[]} previewReady={{ onOpen }} />)
    fireEvent.click(screen.getByRole("button", { name: /Preview ready · Open browser/ }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe("ConversationView timeline rail ticks", () => {
  const blockedTurns = (): Message[] => [
    textMessage("1", "user", "First request"),
    textMessage("2", "assistant", "Done"),
    textMessage("3", "user", "Second request"),
    {
      ...textMessage("4", "assistant", ""),
      parts: [{ _tag: "Question", request: { id: "q", questions: [] }, answers: null }]
    }
  ]

  it("marks a blocked question amber and shows turn stats, Jump and Filter Changes on hover", () => {
    const onFilterChanges = vi.fn()
    render(<ConversationView mode="auto" messages={blockedTurns()} onFilterChanges={onFilterChanges} />)
    const ticks = screen.getAllByRole("button", { name: /^Go to user message/ })
    expect(ticks[1]!.querySelector("[data-slot=preview-rail-tick]")!.getAttribute("data-kind")).toBe("needs-you")

    fireEvent.pointerEnter(ticks[0]!)
    expect(document.querySelector("[data-slot=preview-rail-meta]")!.textContent).toBe("Turn 1")
    fireEvent.click(screen.getByRole("button", { name: "Filter Changes" }))
    expect(onFilterChanges).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy()
  })

  it("moves between turns with alt+up / alt+down", async () => {
    const scrollTo = vi.fn()
    const original = HTMLElement.prototype.scrollTo
    HTMLElement.prototype.scrollTo = scrollTo
    try {
      render(<ConversationView mode="auto" messages={blockedTurns()} />)
      const composer = screen.getByPlaceholderText(/Message/)
      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
      scrollTo.mockClear()
      composer.focus()
      fireEvent.keyDown(composer, { key: "ArrowUp", altKey: true, code: "ArrowUp" })
      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    } finally {
      HTMLElement.prototype.scrollTo = original
    }
  })
})

const pressShiftTab = () => {
  const box = screen.getByPlaceholderText(/Message/)
  box.focus()
  fireEvent.keyDown(box, { key: "Shift", code: "ShiftLeft", shiftKey: true })
  fireEvent.keyDown(box, { key: "Tab", code: "Tab", shiftKey: true })
}

describe("ConversationView work mode hotkey", () => {
  it("shift+tab cycles work mode", async () => {
    const onSetWorkMode = vi.fn()
    const onSetMode = vi.fn()
    const view = render(<ConversationView mode="auto" workMode="build" messages={[]} onSetWorkMode={onSetWorkMode} onSetMode={onSetMode} />)
    pressShiftTab()
    await waitFor(() => expect(onSetWorkMode).toHaveBeenLastCalledWith("plan"))
    view.rerender(<ConversationView mode="auto" workMode="plan" messages={[]} onSetWorkMode={onSetWorkMode} onSetMode={onSetMode} />)
    pressShiftTab()
    await waitFor(() => expect(onSetWorkMode).toHaveBeenLastCalledWith("build"))
    expect(onSetMode).not.toHaveBeenCalled()
  })
})
