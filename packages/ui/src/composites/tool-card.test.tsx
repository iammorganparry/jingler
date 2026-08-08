import type { Message, ToolCall as ToolCallModel } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { MessageTurn } from "./message-turn.js"

/**
 * What the operator needs off a tool card: which FILE is being written (the part
 * a long worktree path pushes out of view), and what a command actually printed.
 */

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(cleanup)
afterAll(() => vi.unstubAllGlobals())

const tool = (t: Partial<ToolCallModel>): Message => ({
  id: "a0",
  role: "assistant",
  streaming: false,
  createdAt: "2026-07-11T10:00:00.000Z",
  parts: [
    {
      _tag: "Tool",
      tool: {
        id: "t1",
        name: "Bash",
        target: "pnpm test",
        status: "success",
        meta: null,
        diff: null,
        preview: null,
        ...t
      } as ToolCallModel
    }
  ]
})

const LONG = "/Users/morganparry/jingler/worktrees/jingler/vivid-dijkstra/.changeset/stop-a-run-search-models-and-honest-plan-steps.md"

describe("tool card — the file being written", () => {
  it("shows the filename in full, however long the path", () => {
    render(<MessageTurn message={tool({ name: "Write", target: LONG })} />)
    // The filename is its own element, so CSS truncation of the directory can
    // never eat it — the failure this fixes showed ".../vivid-dijkstra/.changes…"
    // and cut the filename off entirely.
    expect(screen.getByText("stop-a-run-search-models-and-honest-plan-steps.md")).toBeDefined()
  })

  it("keeps the directory as context, dimmed", () => {
    render(<MessageTurn message={tool({ name: "Write", target: LONG })} />)
    expect(
      screen.getByText("/Users/morganparry/jingler/worktrees/jingler/vivid-dijkstra/.changeset/")
    ).toBeDefined()
  })

  it("does not split a command into directory and filename", () => {
    // A Bash target is a command; slicing it at the last "/" would be nonsense.
    render(<MessageTurn message={tool({ name: "Bash", target: "pnpm --filter @jingler/ui test" })} />)
    expect(screen.getByText("pnpm --filter @jingler/ui test")).toBeDefined()
  })
})

describe("tool card — expanding a call", () => {
  it("reveals the full command and its output on click", () => {
    render(
      <MessageTurn
        message={tool({ name: "Bash", target: "pnpm typecheck", output: "Tasks: 6 successful\nDone in 2.6s" })}
      />
    )
    expect(screen.queryByText(/Done in 2.6s/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText(/Done in 2.6s/)).toBeDefined()
  })

  it("collapses again on a second click", () => {
    render(<MessageTurn message={tool({ output: "hello" })} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByRole("button", { expanded: true })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { expanded: true }))
    expect(screen.queryByText("hello")).toBeNull()
  })

  it("says so when a finished call printed nothing", () => {
    // Distinct from "we didn't capture it" — an empty body would read as a bug.
    render(<MessageTurn message={tool({ target: "true", status: "success" })} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByText("No output.")).toBeDefined()
  })

  it("leaves an edit's card to its diff peek rather than a rival toggle", async () => {
    render(
      <MessageTurn
        message={tool({ name: "Edit", target: "/repo/src/a.ts", preview: "+added a line", diff: { added: 1, removed: 0 } })}
      />
    )
    // The header must not become a toggle: the change is already on show.
    expect(screen.queryByRole("button", { expanded: false })).toBeNull()
    await waitFor(() => {
      const pierre = document.querySelector("diffs-container")
      expect(pierre?.shadowRoot?.textContent).toContain("added a line")
    })
  })
})

describe("plan task progress — protocol stays out of chat", () => {
  it("renders adjacent task markers as compact chips beside the remaining prose", () => {
    const message: Message = {
      id: "a-progress",
      role: "assistant",
      streaming: true,
      createdAt: "2026-08-08T10:00:00.000Z",
      parts: [
        {
          _tag: "Text",
          text:
            "PLAN_TASK stage=S1 fingerprint=secret task=S1-T3 status=completed" +
            "PLAN_TASK stage=S1 fingerprint=secret task=S1-T4 status=in-progress" +
            "The registry tests now cover replay rejection."
        }
      ]
    }

    render(<MessageTurn message={message} />)

    expect(screen.getByText("S1-T3")).toBeDefined()
    expect(screen.getByText("Completed")).toBeDefined()
    expect(screen.getByText("S1-T4")).toBeDefined()
    expect(screen.getByText("In progress")).toBeDefined()
    expect(screen.getByText("The registry tests now cover replay rejection.")).toBeDefined()
    expect(screen.queryByText(/PLAN_TASK/)).toBeNull()
    expect(screen.queryByText(/secret/)).toBeNull()
  })
})
