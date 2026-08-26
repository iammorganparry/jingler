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
