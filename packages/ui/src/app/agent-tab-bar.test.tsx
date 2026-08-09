import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AgentTabBar,
  ChatTabBar,
  MAIN_AGENT,
  type AgentTabItem,
  type VisibleAgentStatus
} from "./agent-tab-bar.js"

afterEach(cleanup)

const item = (
  id: string,
  status: VisibleAgentStatus,
  action?: AgentTabItem["action"]
): AgentTabItem => ({
  id,
  name: id,
  description: `${id} description`,
  status,
  hasChildren: false,
  ...(action === undefined ? {} : { action })
})

const callbacks = () => ({
  onChange: vi.fn(),
  onDrill: vi.fn(),
  onNavigate: vi.fn(),
  onStop: vi.fn(),
  onClose: vi.fn()
})

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

    expect(screen.queryByRole("button", { name: "Closed chats" })).toBeNull()
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

    fireEvent.pointerDown(screen.getByRole("button", { name: "Closed chats" }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole("menuitem", { name: "Reopen Main workspace" }))

    expect(handlers.onReopenChat).toHaveBeenCalledWith("chat-1")
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
})

describe("AgentTabBar legacy agents", () => {
  it("preserves Main navigation, drill-in, settled close, and reviewer controls", () => {
    const handlers = callbacks()
    render(
      <AgentTabBar
        agents={[
          {
            ...item("Explore", "working", "stop"),
            hasChildren: true
          },
          item("Settled", "done", "close"),
          item("Reviewer", "done")
        ]}
        trail={[{ id: "parent", name: "Parent" }]}
        active="Explore"
        {...handlers}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Main" }))
    expect(handlers.onNavigate).toHaveBeenCalledWith(MAIN_AGENT)

    fireEvent.click(
      screen.getByRole("button", { name: "Show Explore's sub-agents" })
    )
    expect(handlers.onDrill).toHaveBeenCalledWith("Explore")

    fireEvent.click(screen.getByRole("button", { name: "Close Settled" }))
    expect(handlers.onClose).toHaveBeenCalledWith("Settled")

    expect(screen.queryByRole("button", { name: "Close Reviewer" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Stop Reviewer" })).toBeNull()
  })
})
