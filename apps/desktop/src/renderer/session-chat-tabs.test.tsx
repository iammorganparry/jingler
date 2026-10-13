// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import type { Session, SubagentFleetNode } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionSubagentTabs } from "./session-chat-tabs.js"
import { clearSubagentTabs, publishSubagentTabs, useSubagentTabSelection } from "./subagent-tab-store.js"

const session = {
  id: "session-1",
  repo: "jingler",
  branch: "feature/files",
  title: "Files",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-08T00:00:00.000Z",
  chats: [{ id: "chat-1", title: "Main", createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z" }],
  activeChatId: "chat-1",
  worktreePath: "/tmp/jingler",
  baseBranch: "main",
  mode: "auto"
} as Session

const subagentNode = (over: Partial<SubagentFleetNode> = {}): SubagentFleetNode => ({
  id: "parent/worker-1",
  subagentId: "worker-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "worker-1",
  parentId: null,
  parentRuntimeSessionId: "parent",
  agent: "worker",
  task: "Implement tabs",
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: false,
  sessionFile: "/sessions/worker.jsonl",
  currentTool: null,
  startedAt: 1,
  updatedAt: 1,
  completedAt: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
  artifacts: [],
  attention: null,
  workspace: null,
  prNumber: null,
  ...over
})

afterEach(() => {
  cleanup()
  clearSubagentTabs(session.id)
})

const openChip = () => fireEvent.pointerDown(screen.getByTestId("subagent-chip"), { button: 0, ctrlKey: false })

describe("SessionSubagentTabs", () => {
  it("renders nothing when the active chat has no subagents", () => {
    render(<SessionSubagentTabs session={session} onSelectConversation={vi.fn()} />)
    expect(screen.queryByTestId("subagent-chip")).toBeNull()
  })

  it("opens live and completed workers for the active chat from the chip popover", () => {
    const worker = subagentNode()
    const reviewer = subagentNode({
      id: "parent/reviewer-1",
      subagentId: "reviewer-1",
      runId: "reviewer-1",
      agent: "reviewer",
      task: "Review tabs",
      status: "completed",
      completedAt: 2,
      terminal: { reason: "completed", summary: "No findings.", at: 2, retryable: false }
    })
    act(() => publishSubagentTabs(session.id, {
      chatId: "chat-1",
      active: [worker],
      completed: [reviewer],
      selectedId: "main"
    }))
    const onSelectConversation = vi.fn()
    render(<SessionSubagentTabs session={session} onSelectConversation={onSelectConversation} />)
    const selection = renderHook(() => useSubagentTabSelection(session.id))
    expect(screen.getByTestId("subagent-chip").textContent).toContain("1 subagent")

    openChip()
    fireEvent.click(screen.getByTestId(`subagent-chip-row-${worker.id}`))
    expect(selection.result.current).toMatchObject({ chatId: "chat-1", nodeId: worker.id })
    expect(onSelectConversation).toHaveBeenCalledOnce()

    openChip()
    fireEvent.click(screen.getByTestId(`subagent-chip-row-${reviewer.id}`))
    expect(selection.result.current).toMatchObject({ chatId: "chat-1", nodeId: reviewer.id })
  })

  it("shows only children of the active chat", () => {
    const second = { id: "chat-2", title: "Second", createdAt: session.updatedAt, updatedAt: session.updatedAt }
    act(() => {
      publishSubagentTabs(session.id, { chatId: "chat-1", active: [subagentNode({ id: "worker-a", task: "Agent A task" })], completed: [], selectedId: "main" })
      publishSubagentTabs(session.id, { chatId: "chat-2", active: [subagentNode({ id: "worker-b", task: "Agent B task" })], completed: [], selectedId: "main" })
    })
    const both = { ...session, chats: [...session.chats, second] }
    const view = render(<SessionSubagentTabs session={both} onSelectConversation={vi.fn()} />)
    openChip()
    expect(screen.getByTestId("subagent-chip-row-worker-a")).toBeTruthy()
    expect(screen.queryByTestId("subagent-chip-row-worker-b")).toBeNull()
    view.unmount()

    render(<SessionSubagentTabs session={{ ...both, activeChatId: "chat-2" }} onSelectConversation={vi.fn()} />)
    openChip()
    expect(screen.queryByTestId("subagent-chip-row-worker-a")).toBeNull()
    expect(screen.getByTestId("subagent-chip-row-worker-b")).toBeTruthy()
  })
})
