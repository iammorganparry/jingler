// @vitest-environment jsdom
import type { Message, PlanDocument } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isSubagentSpawnMessage, MessageTurn, PlanProgressContext, SubagentEntryContext } from "./message-turn.js"

afterEach(cleanup)

const planDocument: PlanDocument = {
  id: "plan",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 1,
  status: "executing",
  plan: {
    title: "Plan",
    sections: [],
    annotations: [],
    stages: [{
      id: "workspace-links",
      title: "Workspace links",
      intent: "Restore links",
      approach: [],
      tasks: [{ id: "plannotator-task-8", text: "Restore links", status: "completed" }],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: []
    }]
  },
  updatedAt: "2026-09-02T00:00:00.000Z",
  updatedBy: "agent"
}

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

  it("renders valid plan markers as native status chips and leaves unknown markers visible", () => {
    const view = render(
      <PlanProgressContext.Provider value={planDocument}>
        <MessageTurn message={assistant({
          streaming: false,
          parts: [{
            _tag: "Text",
            text: "Workspace links restored. [DONE:8] [FAILED:8] [INTERRUPTED:8] [SKIPPED:8] [BLOCKED:8] [ACTIVE:8] [DONE:8] [DONE:99] [UNKNOWN:8]"
          }]
        })} />
      </PlanProgressContext.Provider>
    )

    for (const label of ["Completed", "Failed", "Interrupted", "Skipped", "Blocked", "In progress"]) {
      expect(screen.getByLabelText(`Step 8: ${label}`)).toBeTruthy()
    }
    expect(screen.getAllByLabelText("Step 8: Completed")).toHaveLength(1)
    expect(view.container.textContent).toContain("Workspace links restored.")
    expect(view.container.textContent).toContain("[DONE:99]")
    expect(view.container.textContent).toContain("[UNKNOWN:8]")
    expect(view.container.textContent).not.toContain("[DONE:8]")
  })

  it("renders complete progress markers as chips while the message is streaming", () => {
    const view = render(
      <PlanProgressContext.Provider value={planDocument}>
        <MessageTurn message={assistant({
          parts: [{ _tag: "Text", text: "Starting. [ACTIVE:8] [BLOCKED:8]" }]
        })} />
      </PlanProgressContext.Provider>
    )

    expect(screen.getByLabelText("Step 8: In progress")).toBeTruthy()
    expect(screen.getByLabelText("Step 8: Blocked")).toBeTruthy()
    expect(view.container.textContent).not.toContain("[ACTIVE:8]")
    expect(view.container.textContent).not.toContain("[blocked]")
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

describe("MessageTurn subagent entry points", () => {
  const spawnTurn = assistant({
    streaming: false,
    parts: [{
      _tag: "Tool",
      tool: { id: "t1", name: "subagent", target: null, status: "success", meta: null, diff: null, preview: null }
    }]
  })
  const child = (id: string, agent: string) =>
    ({ id, agent, task: "task", status: "running", startedAt: 0 }) as const
  const entry = (onOpenSubagent: (id: string) => void) => ({
    subagents: [child("a", "Explore"), child("b", "Worker")],
    onOpenSubagent
  })

  it("detects subagent spawn turns", () => {
    expect(isSubagentSpawnMessage(spawnTurn)).toBe(true)
    expect(isSubagentSpawnMessage(assistant())).toBe(false)
  })

  it("View on the subagent tool card opens the first child", () => {
    const open = vi.fn()
    render(
      <SubagentEntryContext.Provider value={entry(open)}>
        <MessageTurn message={spawnTurn} />
      </SubagentEntryContext.Provider>
    )
    fireEvent.click(screen.getByRole("button", { name: "View" }))
    expect(open).toHaveBeenCalledWith("a")
  })

  it("renders no View without children", () => {
    render(
      <SubagentEntryContext.Provider value={{ subagents: [], onOpenSubagent: vi.fn() }}>
        <MessageTurn message={spawnTurn} />
      </SubagentEntryContext.Provider>
    )
    expect(screen.queryByRole("button", { name: "View" })).toBeNull()
  })

  it("shows a Spawned N subagents row whose buttons open each child", () => {
    const open = vi.fn()
    render(
      <SubagentEntryContext.Provider value={entry(open)}>
        <MessageTurn message={spawnTurn} showSubagentRow />
      </SubagentEntryContext.Provider>
    )
    expect(screen.getByTestId("subagent-spawn-row").textContent).toContain("Spawned 2 subagents")
    fireEvent.click(screen.getByTestId("subagent-spawn-row-b"))
    expect(open).toHaveBeenCalledWith("b")
  })

  it("omits the row unless asked", () => {
    render(
      <SubagentEntryContext.Provider value={entry(vi.fn())}>
        <MessageTurn message={spawnTurn} />
      </SubagentEntryContext.Provider>
    )
    expect(screen.queryByTestId("subagent-spawn-row")).toBeNull()
  })
})
