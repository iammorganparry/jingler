// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react"
import type { Session, SubagentFleetNode } from "@jingler/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileBrowserController } from "./use-file-browser.js"
import { rpc } from "./rpc-client.js"
import { SessionChatTabs, SessionSubagentTabs } from "./session-chat-tabs.js"
import {
  clearSubagentTabs,
  publishSubagentTabs,
  useSubagentTabSelection
} from "./subagent-tab-store.js"

const mocks = vi.hoisted(() => ({
  files: null as FileBrowserController | null
}))

vi.mock("./use-file-browser.js", () => ({
  useFileBrowser: () => {
    if (mocks.files === null) throw new Error("Missing file-browser test controller")
    return mocks.files
  }
}))

vi.mock("./conversation-registry.js", () => ({
  disposeChatActor: vi.fn(),
  useChatActivities: () => ({})
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsCreateChat: vi.fn(),
    sessionsSelectChat: vi.fn(),
    sessionsRenameChat: vi.fn(),
    sessionsCloseChat: vi.fn(),
    sessionsReopenChat: vi.fn(),
    agentMessagePeer: vi.fn()
  }
}))

vi.mock("./session-updates.js", () => ({ publishSessionUpdate: vi.fn() }))
vi.mock("./draft-store.js", () => ({ clearDraft: vi.fn() }))

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
  chats: [
    {
      id: "chat-1",
      title: "Main",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z"
    }
  ],
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
  parentPiSessionId: "parent",
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
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolCalls: 0
  },
  artifacts: [],
  attention: null,
  ...over
})

const controller = (
  over: Partial<FileBrowserController> = {}
): FileBrowserController => ({
  entries: [],
  openPaths: ["src/app.ts", "src/other.ts"],
  treeLoading: false,
  treeError: null,
  patch: null,
  patchError: null,
  selectedPath: "src/app.ts",
  payload: null,
  draft: null,
  failure: null,
  pendingDiscard: null,
  viewMode: "edit",
  status: "clean",
  dirty: false,
  followEnabled: false,
  agentTargetPath: null,
  agentTargetEventId: null,
  agentTargetPreview: null,
  agentTargetCompleted: false,
  activate: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  edit: vi.fn(),
  save: vi.fn(),
  refreshConflict: vi.fn(),
  reload: vi.fn(),
  refreshTree: vi.fn(),
  confirmDiscard: vi.fn(),
  cancelDiscard: vi.fn(),
  startEdit: vi.fn(),
  showDiff: vi.fn(),
  enableFollow: vi.fn(),
  disableFollow: vi.fn(),
  followAgentTarget: vi.fn(),
  ...over
})

const renderTabs = (filesActive = true) => {
  const onSelectConversation = vi.fn()
  const onSelectFiles = vi.fn()
  render(<>
    <SessionChatTabs
      session={session}
      filesActive={filesActive}
      onSelectConversation={onSelectConversation}
      onSelectFiles={onSelectFiles}
    />
    <SessionSubagentTabs
      session={session}
      onSelectConversation={onSelectConversation}
    />
  </>)
  return { onSelectConversation, onSelectFiles }
}

beforeEach(() => {
  mocks.files = controller()
})
afterEach(() => {
  cleanup()
  clearSubagentTabs(session.id)
  vi.clearAllMocks()
})

describe("SessionChatTabs subagent tabs", () => {
  it("selects a live worker tab and moves completed output into Previous chats", () => {
    const worker = subagentNode()
    const reviewer = subagentNode({
      id: "parent/reviewer-1",
      subagentId: "reviewer-1",
      runId: "reviewer-1",
      agent: "reviewer",
      task: "Review tabs",
      status: "completed",
      completedAt: 2,
      terminal: {
        reason: "completed",
        summary: "No findings.",
        at: 2,
        retryable: false
      }
    })
    act(() => publishSubagentTabs(session.id, {
      chatId: "chat-1",
      active: [worker],
      completed: [reviewer],
      selectedId: "main"
    }))
    const { onSelectConversation } = renderTabs(false)
    const selection = renderHook(() => useSubagentTabSelection(session.id))

    fireEvent.click(screen.getByRole("button", { name: "worker · Implement tabs" }))
    expect(selection.result.current).toMatchObject({
      chatId: "chat-1",
      nodeId: worker.id
    })
    expect(onSelectConversation).toHaveBeenCalledOnce()

    fireEvent.pointerDown(screen.getByRole("button", { name: "Previous chats" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "Open reviewer · Review tabs" }))
    expect(selection.result.current).toMatchObject({
      chatId: "chat-1",
      nodeId: reviewer.id
    })
  })

  it("opens a completed child by parent chat when child ids collide", () => {
    const secondChat = {
      id: "chat-2",
      title: "Second",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }
    const completed = (task: string) => subagentNode({
      id: "shared-worker",
      task,
      status: "completed",
      completedAt: 2,
      terminal: { reason: "completed", summary: task, at: 2, retryable: false }
    })
    act(() => {
      publishSubagentTabs(session.id, {
        chatId: "chat-1",
        active: [],
        completed: [completed("First history")],
        selectedId: "main"
      })
      publishSubagentTabs(session.id, {
        chatId: "chat-2",
        active: [],
        completed: [completed("Second history")],
        selectedId: "main"
      })
    })
    vi.mocked(rpc.sessionsSelectChat).mockResolvedValue({ ...session, activeChatId: "chat-2" })
    render(
      <SessionChatTabs
        session={{ ...session, chats: [...session.chats, secondChat] }}
        filesActive={false}
        onSelectConversation={vi.fn()}
        onSelectFiles={vi.fn()}
      />
    )
    const selection = renderHook(() => useSubagentTabSelection(session.id))

    fireEvent.pointerDown(screen.getByRole("button", { name: "Previous chats" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "Open worker · Second history" }))

    expect(selection.result.current).toMatchObject({ chatId: "chat-2", nodeId: "shared-worker" })
    expect(rpc.sessionsSelectChat).toHaveBeenCalledWith(session.id, "chat-2")
  })

  it("drops a drafted peer message when the sending agent changes", () => {
    const secondChat = {
      id: "chat-2",
      title: "Second",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }
    const twoChats = { ...session, chats: [...session.chats, secondChat] }
    const view = render(
      <SessionSubagentTabs session={twoChats} onSelectConversation={vi.fn()} />
    )
    fireEvent.click(screen.getByText("Peer agents"))
    fireEvent.click(screen.getByRole("button", { name: "Message Second" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Second" }), {
      target: { value: "draft from chat one" }
    })

    view.rerender(
      <SessionSubagentTabs
        session={{ ...twoChats, activeChatId: "chat-2" }}
        onSelectConversation={vi.fn()}
      />
    )

    expect(screen.queryByDisplayValue("draft from chat one")).toBeNull()
  })

  it("shows only children of the selected top-level agent", () => {
    const secondChat = {
      id: "chat-2",
      title: "Second",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }
    act(() => {
      publishSubagentTabs(session.id, {
        chatId: "chat-1",
        active: [subagentNode({ id: "worker-a", task: "Agent A task" })],
        completed: [],
        selectedId: "main"
      })
      publishSubagentTabs(session.id, {
        chatId: "chat-2",
        active: [subagentNode({ id: "worker-b", task: "Agent B task" })],
        completed: [],
        selectedId: "main"
      })
    })
    const first = { ...session, chats: [...session.chats, secondChat] }
    const view = render(
      <SessionSubagentTabs session={first} onSelectConversation={vi.fn()} />
    )
    expect(screen.getByRole("button", { name: /Agent A task/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Agent B task/ })).toBeNull()

    view.rerender(
      <SessionSubagentTabs
        session={{ ...first, activeChatId: "chat-2" }}
        onSelectConversation={vi.fn()}
      />
    )
    expect(screen.queryByRole("button", { name: /Agent A task/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Agent B task/ })).toBeTruthy()
  })
})

describe("SessionChatTabs file tabs", () => {
  it("renders open files in the shared chat tab row", () => {
    renderTabs()

    expect(screen.getByRole("button", { name: "Collapse chats group" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Collapse files group" })).toBeTruthy()
    expect(screen.getByTestId("chat-tab-chat-1")).toBeTruthy()
    expect(screen.getByTestId("file-tab-src/app.ts")).toBeTruthy()
    expect(screen.getByTestId("file-tab-src/other.ts")).toBeTruthy()
    expect(screen.getByRole("button", { name: "src/app.ts" }).getAttribute("aria-current"))
      .toBe("page")
  })

  it("collapses file tabs without changing the active file", () => {
    renderTabs()

    fireEvent.click(screen.getByRole("button", { name: "Collapse files group" }))

    expect(screen.queryByTestId("file-tab-src/app.ts")).toBeNull()
    const files = mocks.files
    if (files === null) throw new Error("Expected the file browser fixture")
    expect(files.open).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Expand files group" })).toBeTruthy()
  })

  it("selects and closes file tabs through the persistent browser actor", () => {
    mocks.files = controller({ selectedPath: "src/other.ts" })
    const { onSelectFiles } = renderTabs()

    fireEvent.click(screen.getByRole("button", { name: "src/app.ts" }))
    expect(mocks.files.open).toHaveBeenCalledWith("src/app.ts")
    expect(onSelectFiles).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "Close src/other.ts" }))
    expect(mocks.files.close).toHaveBeenCalledWith("src/other.ts")
    expect(onSelectFiles).toHaveBeenCalledTimes(2)
  })

  it("keeps a dirty active file in Files until discard is resolved", () => {
    mocks.files = controller({
      openPaths: ["src/app.ts"],
      selectedPath: "src/app.ts",
      dirty: true,
      status: "dirty"
    })
    const { onSelectConversation, onSelectFiles } = renderTabs()

    fireEvent.click(screen.getByRole("button", { name: "Close src/app.ts" }))

    expect(mocks.files.close).toHaveBeenCalledWith("src/app.ts")
    expect(onSelectFiles).toHaveBeenCalledTimes(1)
    expect(onSelectConversation).not.toHaveBeenCalled()
  })

  it("disambiguates duplicate filenames with their parent paths", () => {
    mocks.files = controller({
      openPaths: ["src/app.ts", "tests/app.ts"],
      selectedPath: "src/app.ts"
    })
    renderTabs()

    expect(within(screen.getByTestId("file-tab-src/app.ts")).getByText("src")).toBeTruthy()
    expect(within(screen.getByTestId("file-tab-tests/app.ts")).getByText("tests")).toBeTruthy()
  })
})
