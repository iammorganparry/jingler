import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatTabBar } from "./chat-tab-bar.js"

afterEach(cleanup)

describe("ChatTabBar closed chats", () => {
  const chatCallbacks = () => ({
    onSelectChat: vi.fn(),
    onCreateChat: vi.fn(),
    onRenameChat: vi.fn(),
    onCloseChat: vi.fn(),
    onReopenChat: vi.fn()
  })

  it("hides the recovery control when no chats are closed", () => {
    render(
      <ChatTabBar
        chats={[{ id: "chat-1", title: "Chat 1" }]}
        closedChats={[]}
        activeChatId="chat-1"
        {...chatCallbacks()}
      />
    )

    expect(screen.queryByRole("button", { name: "Previous chats" })).toBeNull()
  })

  it("reopens a selected chat from the closed-chat menu", () => {
    const handlers = chatCallbacks()
    render(
      <ChatTabBar
        chats={[{ id: "chat-2", title: "Review migrations" }]}
        closedChats={[{ id: "chat-1", title: "Main workspace" }]}
        activeChatId="chat-2"
        {...handlers}
      />
    )

    fireEvent.pointerDown(screen.getByRole("button", { name: "Previous chats" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "Reopen Main workspace" }))

    expect(handlers.onReopenChat).toHaveBeenCalledWith("chat-1")
  })

  it("renders live subagents after their parent chat and opens completed agents from History", () => {
    const onSelectSubagent = vi.fn()
    const onOpenPreviousSubagent = vi.fn()
    render(
      <ChatTabBar
        chats={[
          { id: "chat-1", title: "Main" },
          { id: "chat-2", title: "Other" }
        ]}
        activeChatId=""
        subagentChatId="chat-1"
        subagents={[{
          id: "worker-1",
          title: "worker · Implement tabs",
          status: "running"
        }]}
        activeSubagentId="worker-1"
        onSelectSubagent={onSelectSubagent}
        previousSubagents={[{
          id: "reviewer-1",
          title: "reviewer · Review tabs"
        }]}
        onOpenPreviousSubagent={onOpenPreviousSubagent}
        {...chatCallbacks()}
      />
    )

    const chat = screen.getByTestId("chat-tab-chat-1")
    const subagent = screen.getByTestId("subagent-tab-worker-1")
    expect(chat.nextElementSibling).toBe(subagent)
    expect(subagent.getAttribute("aria-current")).toBe("page")
    fireEvent.click(subagent)
    expect(onSelectSubagent).toHaveBeenCalledWith("worker-1")

    fireEvent.pointerDown(screen.getByRole("button", { name: "Previous chats" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "Open reviewer · Review tabs" }))
    expect(onOpenPreviousSubagent).toHaveBeenCalledWith("reviewer-1")
  })

  it("collapses chats and files into independently labelled groups", () => {
    render(
      <ChatTabBar
        chats={[
          { id: "chat-1", title: "Main" },
          { id: "chat-2", title: "Review" }
        ]}
        activeChatId=""
        fileSlot={[
          <button key="one">app.ts</button>,
          <button key="two">app.test.ts</button>
        ]}
        filesActive
        {...chatCallbacks()}
      />
    )

    expect(screen.getByTitle("2 open chats")).toBeTruthy()
    expect(screen.getByTitle("2 open files")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Collapse chats group" }))
    expect(screen.queryByRole("button", { name: "Main" })).toBeNull()
    expect(screen.getByRole("button", { name: "app.ts" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Collapse files group" }))
    expect(screen.queryByRole("button", { name: "app.ts" })).toBeNull()
    expect(screen.getByRole("button", { name: "Expand chats group" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Expand files group" })).toBeTruthy()
  })

  it("closes all chats or files from the group label's context menu", () => {
    const onCloseAllChats = vi.fn()
    const onCloseAllFiles = vi.fn()
    render(
      <ChatTabBar
        chats={[{ id: "chat-1", title: "Main" }]}
        activeChatId="chat-1"
        fileSlot={[<button key="one">app.ts</button>]}
        onCloseAllChats={onCloseAllChats}
        onCloseAllFiles={onCloseAllFiles}
        {...chatCallbacks()}
      />
    )

    fireEvent.contextMenu(screen.getByRole("button", { name: "Collapse chats group" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Close all chats" }))
    expect(onCloseAllChats).toHaveBeenCalledOnce()

    fireEvent.contextMenu(screen.getByRole("button", { name: "Collapse files group" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Close all files" }))
    expect(onCloseAllFiles).toHaveBeenCalledOnce()
  })
})
