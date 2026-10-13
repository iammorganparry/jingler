import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ExplanationDocument } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ExplanationView } from "./explanation-view.js"

const document: ExplanationDocument = {
  id: "explanation-1",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 1,
  title: "How publishing works",
  summary: "A typed artifact flows from agent to view.",
  sections: [{
    id: "shape",
    title: "Runtime shape",
    blocks: [
      { kind: "prose", id: "intro", text: "The boundary is **typed**." },
      { kind: "code", id: "tree", language: "text", code: "agent\n  store\n    view" },
      { kind: "table", id: "roles", headers: ["Part", "Role"], rows: [["Store", "Persist"]] },
      { kind: "diagram", id: "flow", source: "flowchart LR\n  Agent --> View" }
    ]
  }],
  updatedAt: "2026-08-12T12:00:00.000Z"
}

afterEach(cleanup)

describe("ExplanationView", () => {
  it("renders prose, code, table, and Mermaid sections", () => {
    render(<ExplanationView document={document} />)
    expect(screen.getByRole("article", { name: "Technical explanation" })).toBeTruthy()
    expect(screen.getByRole("region", { name: "Runtime shape" })).toBeTruthy()
    expect(globalThis.document.querySelector("code")?.textContent).toBe("agent\n  store\n    view")
    expect(screen.getByRole("table")).toBeTruthy()
    expect(globalThis.document.querySelector('[data-plan-block="flow"]')).toBeTruthy()
  })

  it("shows bounded loading and empty states", () => {
    const { rerender } = render(<ExplanationView document={null} loading />)
    expect(screen.getByText("Loading explanation…")).toBeTruthy()
    rerender(<ExplanationView document={null} />)
    expect(screen.getByText("No explanation yet.")).toBeTruthy()
  })

  it("shows an error with Retry that calls onRetry", () => {
    const onRetry = vi.fn()
    render(<ExplanationView document={null} error="Could not load." onRetry={onRetry} />)
    expect(screen.getByRole("alert").textContent).toContain("Could not load.")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("renders a contents rail for multi-section documents", () => {
    const second = { ...document.sections[0]!, id: "second", title: "Second" }
    render(<ExplanationView document={{ ...document, sections: [...document.sections, second] }} />)
    expect(screen.getByRole("navigation", { name: "Explanation contents" })).toBeTruthy()
  })
})
