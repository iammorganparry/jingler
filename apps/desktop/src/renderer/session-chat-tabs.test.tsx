// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { Session } from "@jingler/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileBrowserController } from "./use-file-browser.js"
import { SessionChatTabs } from "./session-chat-tabs.js"

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
  rehomeSharedPlan: vi.fn(),
  useChatActivities: () => ({})
}))

vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsCreateChat: vi.fn(),
    sessionsSelectChat: vi.fn(),
    sessionsRenameChat: vi.fn(),
    sessionsCloseChat: vi.fn(),
    sessionsReopenChat: vi.fn()
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
  cli: "codex",
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
  render(
    <SessionChatTabs
      session={session}
      filesActive={filesActive}
      onSelectConversation={onSelectConversation}
      onSelectFiles={onSelectFiles}
    />
  )
  return { onSelectConversation, onSelectFiles }
}

beforeEach(() => {
  mocks.files = controller()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SessionChatTabs file tabs", () => {
  it("renders open files in the shared chat tab row", () => {
    renderTabs()

    expect(screen.getByTestId("chat-tab-chat-1")).toBeTruthy()
    expect(screen.getByTestId("file-tab-src/app.ts")).toBeTruthy()
    expect(screen.getByTestId("file-tab-src/other.ts")).toBeTruthy()
    expect(screen.getByRole("button", { name: "src/app.ts" }).getAttribute("aria-current"))
      .toBe("page")
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
