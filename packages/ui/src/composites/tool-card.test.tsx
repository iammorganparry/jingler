import type { Message, ToolCall as ToolCallModel } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { MessageTurn, ToolStopContext } from "./message-turn.js"

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
    expect(screen.getAllByText("pnpm --filter @jingler/ui test").length).toBeGreaterThan(0)
  })
})

describe("tool card — expanding a call", () => {
  it("reveals the full command and its output on click", () => {
    render(
      <MessageTurn
        message={tool({ name: "Bash", target: "pnpm typecheck", output: "Tasks: 6 successful\nDone in 2.6s" })}
      />
    )
    expect(screen.getByRole("region", { hidden: true }).getAttribute("aria-hidden")).toBe("true")
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByRole("log").textContent).toContain("Done in 2.6s")
  })

  it("collapses again on a second click", () => {
    render(<MessageTurn message={tool({ output: "hello" })} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.getByRole("button", { expanded: true })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { expanded: true }))
    expect(screen.getByRole("region", { hidden: true }).getAttribute("aria-hidden")).toBe("true")
  })

  it("keeps large command output in one bounded scroll region", () => {
    render(<MessageTurn message={tool({ output: Array.from({ length: 600 }, (_, index) => `line ${index}`).join("\n") })} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    const log = screen.getByRole("log")
    expect(log.style.maxHeight).toBe("320px")
    expect(log.querySelectorAll("pre")).toHaveLength(1)
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
    await waitFor(() => expect(document.body.textContent).toContain("added a line"))
    expect(document.querySelector("diffs-container")).toBeNull()
  })
})

describe("tool card — canonical file changes", () => {
  it("renders create, modify, delete, and rename evidence from actual workspace state", async () => {
    render(
      <MessageTurn
        message={tool({
          name: "Workspace changes",
          target: null,
          diff: { added: 3, removed: 2 },
          fileChanges: {
            id: "changes-1",
            callId: "t1",
            changes: [
              { status: "A", path: "src/new.ts", oldPath: null, added: 1, removed: 0, binary: false, noNewlineAtEnd: false, beforeBytes: 0, afterBytes: 12, preview: "+new", patchArtifactId: "patch-a" },
              { status: "M", path: "src/edit.ts", oldPath: null, added: 1, removed: 1, binary: false, noNewlineAtEnd: true, beforeBytes: 10, afterBytes: 12, preview: "-old\n+new", patchArtifactId: "patch-m" },
              { status: "D", path: "src/gone.ts", oldPath: null, added: 0, removed: 1, binary: false, noNewlineAtEnd: false, beforeBytes: 10, afterBytes: 0, preview: "-gone", patchArtifactId: "patch-d" },
              { status: "R", path: "src/after.ts", oldPath: "src/before.ts", added: 1, removed: 0, binary: false, noNewlineAtEnd: false, beforeBytes: 10, afterBytes: 12, preview: "+changed", patchArtifactId: "patch-r" }
            ],
            totals: { added: 3, removed: 2 },
            authoritative: true,
            reconciledAt: "2026-08-10T12:00:00.000Z"
          }
        })}
      />
    )

    expect(screen.getByText("Created")).toBeDefined()
    expect(screen.getByText("Modified")).toBeDefined()
    expect(screen.getByText("Deleted")).toBeDefined()
    expect(screen.getByText("Renamed")).toBeDefined()
    expect(screen.getByText("src/before.ts")).toBeDefined()
    expect(screen.getByText("src/after.ts")).toBeDefined()
    expect(screen.getByText("No newline")).toBeDefined()
    await waitFor(() => {
      expect(document.body.textContent).toContain("changed")
      expect(document.querySelectorAll("[data-material-file-icon]")).toHaveLength(8)
    })
  })

  it("limits final reconciliation to ten files and expands without truncating other tool cards", () => {
    const changes = Array.from({ length: 12 }, (_, index) => ({
      status: "M" as const,
      path: `src/file-${index + 1}.ts`,
      oldPath: null,
      added: 1,
      removed: 0,
      binary: false,
      noNewlineAtEnd: false,
      beforeBytes: 1,
      afterBytes: 2,
      preview: null,
      patchArtifactId: null
    }))
    const fileChanges = {
      id: "changes-many",
      callId: "reconcile:changes-many",
      changes,
      totals: { added: 12, removed: 0 },
      authoritative: true as const,
      reconciledAt: "2026-08-10T12:00:00.000Z"
    }
    const { rerender } = render(
      <MessageTurn message={tool({ id: "reconcile:changes-many", name: "Workspace changes", fileChanges })} />
    )

    expect(document.querySelectorAll("[data-file-path]")).toHaveLength(10)
    fireEvent.click(screen.getByRole("button", { name: "View more (2 files)" }))
    expect(document.querySelectorAll("[data-file-path]")).toHaveLength(12)
    fireEvent.click(screen.getByRole("button", { name: "View less" }))
    expect(document.querySelectorAll("[data-file-path]")).toHaveLength(10)

    rerender(<MessageTurn message={tool({ id: "ordinary", fileChanges })} />)
    expect(document.querySelectorAll("[data-file-path]")).toHaveLength(12)
    expect(screen.queryByRole("button", { name: /View more/ })).toBeNull()
  })

  it("labels binary changes without pretending they have a text diff", () => {
    render(
      <MessageTurn
        message={tool({
          fileChanges: {
            id: "changes-binary",
            callId: "t1",
            changes: [{ status: "M", path: "logo.png", oldPath: null, added: 0, removed: 0, binary: true, noNewlineAtEnd: false, beforeBytes: 10, afterBytes: 20, preview: null, patchArtifactId: null }],
            totals: { added: 0, removed: 0 },
            authoritative: true,
            reconciledAt: "2026-08-10T12:00:00.000Z"
          }
        })}
      />
    )
    expect(screen.getByText("Binary")).toBeDefined()
    expect(screen.getByText("1 file · +0 −0")).toBeDefined()
  })
})

describe("tool card — stopping a hung command", () => {
  it("shows a stop button on a running Bash tool and fires the interrupt", () => {
    const onStop = vi.fn()
    render(
      <ToolStopContext.Provider value={onStop}>
        <MessageTurn message={tool({ name: "Bash", target: "sleep 999", status: "running" })} />
      </ToolStopContext.Provider>
    )
    fireEvent.click(screen.getByLabelText("Stop tool"))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("hides the stop button on a non-command tool and on a settled command", () => {
    const { rerender } = render(
      <ToolStopContext.Provider value={vi.fn()}>
        <MessageTurn message={tool({ name: "Read", target: "a.ts", status: "running" })} />
      </ToolStopContext.Provider>
    )
    expect(screen.queryByLabelText("Stop tool")).toBeNull()

    rerender(
      <ToolStopContext.Provider value={vi.fn()}>
        <MessageTurn message={tool({ name: "Bash", target: "ls", status: "success" })} />
      </ToolStopContext.Provider>
    )
    expect(screen.queryByLabelText("Stop tool")).toBeNull()
  })
})
