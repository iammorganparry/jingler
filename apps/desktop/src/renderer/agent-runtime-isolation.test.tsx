// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Session } from "@jingler/core"
import { SessionPane } from "../../../../packages/ui/src/screens/session-pane.js"
import { allTabs } from "../../../../packages/ui/src/app/editor-layout.js"
import { editorLayoutOf, resetEditorLayouts } from "../../../../packages/ui/src/app/editor-layout-machine.js"
import { createActor } from "xstate"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  previewDockMachine,
  previewOwnerId,
  previewSessionState
} from "./preview-dock-machine.js"

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  resetEditorLayouts()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    }
  })
})
afterEach(cleanup)

const baseSession = {
  id: "session",
  repo: "widget",
  branch: "main",
  title: "Agents",
  status: "idle",
  chats: [
    { id: "a", title: "Agent A", createdAt: "now", updatedAt: "now" },
    { id: "b", title: "Agent B", createdAt: "now", updatedAt: "now" }
  ],
  activeChatId: "a",
  worktreePath: "/tmp/widget",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "now"
} as unknown as Session

describe("agent runtime ownership matrix", () => {
  it("keeps Plan and Browser presentation on the selected chat during hostile background events", async () => {
    const browser = new Map<string, boolean>([["a", false], ["b", false]])
    const pane = (session: Session) => (
      <SessionPane
        session={session}
        planSessions={new Set(["a"])}
        isBrowserActive={(_sessionId, chatId) => browser.get(chatId) ?? false}
        onToggleBrowser={(_sessionId, chatId) => browser.set(chatId, !(browser.get(chatId) ?? false))}
        renderConversation={(owner, view) => (
          <span data-testid="view">{owner.activeChatId}:{view}</span>
        )}
      />
    )
    const view = render(pane(baseSession))
    fireEvent.click(screen.getByRole("button", { name: "Plan" }))
    expect(screen.getAllByTestId("view").map((node) => node.textContent)).toContain("a:plan")

    view.rerender(pane({ ...baseSession, activeChatId: "b" }))
    expect(screen.getAllByTestId("view").map((node) => node.textContent)).toContain("b:conversation")

    // Agent A opens its browser in the background while B remains selected.
    browser.set("a", true)
    view.rerender(pane({ ...baseSession, activeChatId: "b" }))
    expect(screen.getAllByTestId("view").map((node) => node.textContent)).toContain("b:conversation")
    expect(screen.queryByTestId("session-browser-panel")).toBeNull()

    browser.set("b", true)
    view.rerender(pane({ ...baseSession, activeChatId: "b" }))
    await waitFor(() =>
      expect(
        allTabs(editorLayoutOf(baseSession.id)!).some(
          (surface) => surface.kind === "view" && surface.id === "browser" && surface.chatId === "b"
        )
      ).toBe(true)
    )

    // Chat switching selects that chat surface; opened Browser tabs remain
    // available without taking focus back from the operator.
    for (const chatId of ["a", "b", "a", "b"] as const) {
      view.rerender(pane({ ...baseSession, activeChatId: chatId }))
      await waitFor(() =>
        expect(screen.getAllByTestId("view").map((node) => node.textContent))
          .toContain(`${chatId}:conversation`)
      )
    }
  })

  it("keeps colliding browser URLs and reveals isolated under rapid events", () => {
    const actor = createActor(previewDockMachine).start()
    const a = previewOwnerId("session", "a")
    const b = previewOwnerId("session", "b")
    actor.send({ type: "FOCUS_SESSION", sessionId: b })
    for (let index = 0; index < 25; index += 1) {
      actor.send({ type: "REVEAL_BROWSER", sessionId: a, url: `https://same.test/a-${index}` })
      actor.send({ type: "NATIVE_URL", sessionId: b, url: `https://same.test/b-${index}` })
    }
    const snapshot = actor.getSnapshot()
    expect(snapshot.context.focusedSessionId).toBe(b)
    expect(previewSessionState(snapshot.context, a).url).toBe("https://same.test/a-24")
    expect(previewSessionState(snapshot.context, b).url).toBe("https://same.test/b-24")
  })
})
