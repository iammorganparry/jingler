import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { editorTabMime } from "../app/editor-groups.js"
import { resetEditorLayouts } from "../app/editor-layout-machine.js"
import { testSession as session } from "../test-support.js"
import { SessionPane } from "./session-pane.js"

beforeEach(() => {
  localStorage.clear()
  resetEditorLayouts()
})
afterEach(cleanup)

describe("SessionPane editor-group regressions", () => {
  it("updates an already-mounted Plan body when its step target changes", () => {
    const owner = session({ id: "plan-target" })
    render(
      <SessionPane
        session={owner}
        planSessions={new Set([owner.activeChatId])}
        renderConversation={(_session, view, ctx) => (
          <div data-testid={`target-${view}`}>
            <span>{ctx.planStepId ?? "none"}</span>
            <button type="button" onClick={() => ctx.onOpenPlanReview(view === "plan" ? "step-2" : "step-1")}>advance</button>
          </div>
        )}
      />
    )
    fireEvent.click(within(screen.getByTestId("target-conversation")).getByRole("button", { name: "advance" }))
    expect(within(screen.getByTestId("target-plan")).getByText("step-1")).toBeTruthy()
    fireEvent.click(within(screen.getByTestId("target-plan")).getByRole("button", { name: "advance" }))
    expect(within(screen.getByTestId("target-plan")).getByText("step-2")).toBeTruthy()
  })

  it("binds a background chat's plan callback to that chat", () => {
    const focusChat = vi.fn()
    const owner = session({
      id: "plan-owner",
      chats: [
        { id: "chat-a", title: "A", createdAt: "now", updatedAt: "now" },
        { id: "chat-b", title: "B", createdAt: "now", updatedAt: "now" }
      ],
      activeChatId: "chat-a"
    })
    render(
      <SessionPane
        session={owner}
        onFocusChat={focusChat}
        planSessions={new Set()}
        renderConversation={(chat, view, ctx) => (
          <div data-testid={`${chat.activeChatId}-${view}`}>
            <button type="button" onClick={ctx.onPlanDraftAvailable}>draft {chat.activeChatId}</button>
          </div>
        )}
      />
    )
    fireEvent.drop(screen.getByTestId("editor-group"), {
      dataTransfer: {
        types: [editorTabMime(owner.id)],
        getData: () => JSON.stringify({ surface: { kind: "chat", id: "chat-b" } })
      }
    })
    fireEvent.click(within(screen.getByTestId("editor-tab-chat-chat-a")).getByRole("tab"))
    fireEvent.click(screen.getByTestId("chat-b-conversation").querySelector("button")!)
    expect(screen.getByTestId("chat-b-plan")).toBeTruthy()
    expect(screen.queryByTestId("chat-a-plan")).toBeNull()
    expect(focusChat).toHaveBeenLastCalledWith(owner.id, "chat-b")
  })

  it("notifies the host when the active chat tab is selected again", () => {
    const focusChat = vi.fn()
    const owner = session({ id: "reselect-chat" })
    render(
      <SessionPane
        session={owner}
        onFocusChat={focusChat}
        renderConversation={() => <div>chat</div>}
      />
    )

    fireEvent.click(screen.getByRole("tab", { name: "Chat 1" }))

    expect(focusChat).toHaveBeenCalledExactlyOnceWith(owner.id, owner.activeChatId)
  })

  it("offers an untouched chat for disposal when its last tab closes", () => {
    const discard = vi.fn()
    const owner = session({
      id: "empty-chat-close",
      chats: [
        { id: "chat-a", title: "A", createdAt: "now", updatedAt: "now" },
        { id: "chat-b", title: null, createdAt: "now", updatedAt: "now" }
      ],
      activeChatId: "chat-b"
    })
    render(
      <SessionPane
        session={owner}
        onCloseUntouchedChat={discard}
        renderConversation={() => <div>chat</div>}
      />
    )

    fireEvent.click(within(screen.getByTestId("editor-tab-chat-chat-b")).getByRole("button", { name: "Close Chat 2" }))

    expect(discard).toHaveBeenCalledOnce()
    expect(discard).toHaveBeenCalledWith(owner.id, "chat-b")
  })

  it("mounts one Browser body and closes its shared state with its only tab", () => {
    const toggle = vi.fn()
    render(
      <SessionPane
        session={session({ id: "browser-single" })}
        isBrowserActive={() => true}
        onToggleBrowser={toggle}
        renderConversation={() => <div>chat</div>}
        renderBrowser={(_owner, visible) => <span data-testid="browser-visible">{String(visible)}</span>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Browser" }))
    expect(screen.getAllByTestId("browser-visible").map((node) => node.textContent)).toEqual(["true"])
    expect(screen.getAllByTestId("editor-group")).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Close Browser" }))
    expect(toggle).toHaveBeenCalledOnce()
    expect(screen.getAllByTestId("editor-group")).toHaveLength(1)
  })

  it("closes a file document through its only content tab", () => {
    const requestClose = vi.fn(() => true)
    render(
      <SessionPane
        session={session({ id: "file-single" })}
        onRequestCloseFile={requestClose}
        renderConversation={(_owner, _view, ctx) => <button type="button" onClick={() => ctx.onOpenFile("src/a.ts")}>file</button>}
        renderFiles={(_owner, ctx) => <div>file {ctx.path}</div>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "file" }))
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }))
    expect(requestClose).toHaveBeenCalledExactlyOnceWith("file-single", "src/a.ts")
  })

  it("prunes an open Plan tab when its plan ceases to exist", async () => {
    const owner = session({ id: "plan-prune" })
    const props = { session: owner, renderConversation: () => <div>body</div> }
    const view = render(<SessionPane {...props} planSessions={new Set([owner.activeChatId])} />)
    fireEvent.click(screen.getByRole("button", { name: "Plan" }))
    expect(screen.getByTestId("editor-tab-view-plan")).toBeTruthy()
    view.rerender(<SessionPane {...props} planSessions={new Set()} />)
    await waitFor(() => expect(screen.queryByTestId("editor-tab-view-plan")).toBeNull())
  })

  it("clears a pending Plan tab when its streamed draft fails", () => {
    render(
      <SessionPane
        session={session({ id: "plan-failure" })}
        planSessions={new Set()}
        renderConversation={(_owner, view, ctx) => (
          <div data-testid={`draft-${view}`}>
            <button type="button" onClick={ctx.onPlanDraftAvailable}>available</button>
            <button type="button" onClick={ctx.onPlanDraftUnavailable}>failed</button>
          </div>
        )}
      />
    )
    fireEvent.click(within(screen.getByTestId("draft-conversation")).getByRole("button", { name: "available" }))
    expect(screen.getByTestId("editor-tab-view-plan")).toBeTruthy()
    fireEvent.click(within(screen.getByTestId("draft-plan")).getByRole("button", { name: "failed" }))
    expect(screen.queryByTestId("editor-tab-view-plan")).toBeNull()
  })

  it("keeps all chats in the same group", () => {
    const owner = session({
      id: "chat-lane",
      chats: [
        { id: "chat-a", title: "A", createdAt: "now", updatedAt: "now" },
        { id: "chat-b", title: "B", createdAt: "now", updatedAt: "now" }
      ],
      activeChatId: "chat-a"
    })
    const view = render(<SessionPane session={owner} renderConversation={(chat) => <div>{chat.activeChatId}</div>} />)
    view.rerender(<SessionPane session={{ ...owner, activeChatId: "chat-b" }} renderConversation={(chat) => <div>{chat.activeChatId}</div>} />)
    expect(within(screen.getByTestId("editor-group")).getAllByRole("tab")).toHaveLength(2)
  })

  it("mounts one visible terminal in the content pane", () => {
    render(
      <SessionPane
        session={session({ id: "terminal-visible" })}
        renderConversation={() => <div>chat</div>}
        renderTerminal={(_owner, visible) => <span data-testid="terminal-visible">{String(visible)}</span>}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }))
    expect(screen.getAllByTestId("terminal-visible").map((node) => node.textContent)).toEqual(["true"])
    expect(screen.getAllByTestId("editor-group")).toHaveLength(2)
  })
})
