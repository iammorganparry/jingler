import type { ConversationSearchHit } from "@jingler/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { CommandPalette, PALETTE_PLACEHOLDER } from "./command-palette.js"

afterEach(cleanup)
const hit: ConversationSearchHit = {
  sessionId: "s", chatId: "c", messageId: "m", messageIndex: 0, before: "v1:50", sessionTitle: "Storage cleanup", chatTitle: "Retry work", repo: "widget", role: "assistant", snippet: "Fixed the quartzcapybara retry regression."
}

describe("conversation results in the existing palette", () => {
  it("renders an asynchronously found snippet and closes before navigating with Enter", async () => {
    const order: string[] = []
    render(<CommandPalette open items={[]} onOpenChange={() => order.push("close")}
      searchConversations={async () => ({ hits: [hit], hasMore: false })}
      onOpenConversation={(result, query) => order.push(query, result.messageId)} />)
    const input = screen.getByPlaceholderText(PALETTE_PLACEHOLDER)
    fireEvent.change(input, { target: { value: "quartzcapybara" } })
    await screen.findByTestId("conversation-search-hit")
    expect(screen.getByTestId("conversation-search-hit").querySelector("mark")?.textContent).toBe("quartzcapybara")
    await waitFor(() => expect(screen.getByTestId("conversation-search-hit").getAttribute("data-selected")).toBe("true"))
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(order).toEqual(["close", "quartzcapybara", "m"]))
  })

  it("keeps Enter usable after Chat scope removes the selected workspace result", async () => {
    const opened: string[] = []
    const archived = { ...hit, sessionId: "archived", chatId: "archived-chat", messageId: "archived", snippet: "Archived quartzcapybara result" }
    render(<CommandPalette open items={[]} onOpenChange={() => {}}
      searchConversations={async (_query, scope) => ({ hits: scope === "workspace" ? [archived, hit] : [hit], hasMore: false })}
      onOpenConversation={(result) => opened.push(result.messageId)} />)
    const input = screen.getByPlaceholderText(PALETTE_PLACEHOLDER)
    fireEvent.change(input, { target: { value: "quartzcapybara" } })
    await waitFor(() => expect(screen.getAllByTestId("conversation-search-hit")).toHaveLength(2))
    await waitFor(() => expect(screen.getAllByTestId("conversation-search-hit")[0]?.getAttribute("data-selected")).toBe("true"))
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }))
    await waitFor(() => expect(screen.getAllByTestId("conversation-search-hit")).toHaveLength(1))
    expect(screen.getByTestId("conversation-search-hit").textContent).toContain(hit.snippet)
    await waitFor(() => expect(screen.getByTestId("conversation-search-hit").getAttribute("data-selected")).toBe("true"))
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(opened).toEqual(["m"]))
  })

  it("does not start a disk search for short queries or command-only scope", async () => {
    const requests: string[] = []
    render(<CommandPalette open items={[]} onOpenChange={() => {}}
      searchConversations={async (query) => { requests.push(query); return { hits: [], hasMore: false } }}
      onOpenConversation={() => {}} />)
    const input = screen.getByPlaceholderText(PALETTE_PLACEHOLDER)
    fireEvent.change(input, { target: { value: "ab" } })
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.change(input, { target: { value: ">" } })
    fireEvent.change(input, { target: { value: "Settings" } })
    await waitFor(() => expect(screen.getByText("No matching commands")).toBeTruthy())
    expect(requests).toEqual([])
  })
})
