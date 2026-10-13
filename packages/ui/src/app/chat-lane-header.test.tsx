import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatLaneHeader } from "./chat-lane-header.js"

afterEach(cleanup)

describe("ChatLaneHeader", () => {
  it("displays the active chat title in the thread switcher", () => {
    render(
      <ChatLaneHeader
        chats={[
          { id: "chat-1", title: "Main workspace" },
          { id: "chat-2", title: "Review migrations" }
        ]}
        activeChatId="chat-1"
        onSelectChat={vi.fn()}
        onCreateChat={vi.fn()}
      />
    )

    expect(screen.getByTestId("thread-switcher")).toBeTruthy()
    expect(screen.getByText("Main workspace")).toBeTruthy()
  })

  it("switches chats when selecting from the dropdown", () => {
    const onSelectChat = vi.fn()
    render(
      <ChatLaneHeader
        chats={[
          { id: "chat-1", title: "Main workspace" },
          { id: "chat-2", title: "Review migrations" }
        ]}
        activeChatId="chat-1"
        onSelectChat={onSelectChat}
        onCreateChat={vi.fn()}
      />
    )

    fireEvent.pointerDown(screen.getByTestId("thread-switcher"), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByTestId("chat-option-chat-2"))

    expect(onSelectChat).toHaveBeenCalledWith("chat-2")
  })

  it("creates a new chat when clicking the + button", () => {
    const onCreateChat = vi.fn()
    render(
      <ChatLaneHeader
        chats={[{ id: "chat-1", title: "Main workspace" }]}
        activeChatId="chat-1"
        onSelectChat={vi.fn()}
        onCreateChat={onCreateChat}
      />
    )

    fireEvent.click(screen.getByTestId("new-chat-button"))

    expect(onCreateChat).toHaveBeenCalledOnce()
  })

  it("shows running status for active running chats", () => {
    const { container } = render(
      <ChatLaneHeader
        chats={[
          { id: "chat-1", title: "Main workspace", running: true },
          { id: "chat-2", title: "Review migrations" }
        ]}
        activeChatId="chat-1"
        onSelectChat={vi.fn()}
        onCreateChat={vi.fn()}
      />
    )

    const switcher = screen.getByTestId("thread-switcher")
    // Spec §6.3: running is a neutral pulsing dot, never yellow.
    expect(switcher.querySelector(".bg-muted-foreground")).toBeTruthy()
    expect(switcher.querySelector(".bg-yellow")).toBeNull()
  })

  it("toggles follow-agent mode when the button is clicked", () => {
    const onToggleFollowAgent = vi.fn()
    render(
      <ChatLaneHeader
        chats={[{ id: "chat-1", title: "Main workspace" }]}
        activeChatId="chat-1"
        onSelectChat={vi.fn()}
        onCreateChat={vi.fn()}
        followAgent={false}
        onToggleFollowAgent={onToggleFollowAgent}
      />
    )

    const toggle = screen.getByTestId("follow-agent-toggle")
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(toggle)

    expect(onToggleFollowAgent).toHaveBeenCalledWith(true)
  })

  it("shows active state when follow-agent is enabled", () => {
    render(
      <ChatLaneHeader
        chats={[{ id: "chat-1", title: "Main workspace" }]}
        activeChatId="chat-1"
        onSelectChat={vi.fn()}
        onCreateChat={vi.fn()}
        followAgent={true}
        onToggleFollowAgent={vi.fn()}
      />
    )

    const toggle = screen.getByTestId("follow-agent-toggle")
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
  })

  it("hides follow-agent toggle when callback is not provided", () => {
    render(
      <ChatLaneHeader
        chats={[{ id: "chat-1", title: "Main workspace" }]}
        activeChatId="chat-1"
        onSelectChat={vi.fn()}
        onCreateChat={vi.fn()}
      />
    )

    expect(screen.queryByTestId("follow-agent-toggle")).toBeNull()
  })

  it("includes a reserved subagent chip slot", () => {
    render(
      <ChatLaneHeader
        chats={[{ id: "chat-1", title: "Main workspace" }]}
        activeChatId="chat-1"
        onSelectChat={vi.fn()}
        onCreateChat={vi.fn()}
      />
    )

    expect(screen.getByTestId("subagent-slot")).toBeTruthy()
  })
})
