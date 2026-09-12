import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { testSession } from "../test-support.js"
import { SessionConversation } from "./session-conversation.js"

const projects: Project[] = ["alpha", "beta", "empty"].map((id) => ({
  id, name: id, path: `/repos/${id}`, availability: "available",
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
}))
const sessions = [
  testSession({ id: "a1", projectId: "alpha", title: "Alpha one" }),
  testSession({ id: "a2", projectId: "alpha", title: "Alpha two" }),
  testSession({ id: "b1", projectId: "beta", title: "Beta one", updatedAt: "2026-01-01" }),
  testSession({ id: "b2", projectId: "beta", title: "Beta two", updatedAt: "2026-02-01" }),
  testSession({ id: "b3", projectId: "beta", title: "Archived beta", updatedAt: "2026-03-01", archived: true })
]

function Navigation({ showEmpty = true }: { showEmpty?: boolean }) {
  const [active, setActive] = useState("a1")
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [currentSessions, setCurrentSessions] = useState(sessions)
  return <>
    <output aria-label="Active session">{active}</output>
    <output aria-label="Selected project">{selectedProjectId}</output>
    <button type="button" onClick={() => setCurrentSessions((current) => current.map((session) =>
      session.id === "a1" ? { ...session, updatedAt: "2026-08-01T00:00:00.000Z" } : session
    ))}>Update Alpha</button>
    <button type="button" onClick={() => setCurrentSessions((current) => current.map((session) =>
      session.id === "b1" ? { ...session, archived: true } : session
    ))}>Archive Beta one</button>
    <button type="button" onClick={() => setCurrentSessions((current) => current.filter((session) => session.id !== "b1"))}>Delete Beta one</button>
    <SessionConversation projects={projects} sessions={currentSessions} activeSessionId={active}
      selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId}
      onSelectSession={setActive} showEmpty={showEmpty} renderConversation={(session) => <div data-testid="session-content">{session.id}</div>} />
  </>
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it("opens the newest active session on first visit and restores the last viewed session on return", () => {
  render(<Navigation />)
  fireEvent.click(screen.getByRole("button", { name: "beta" }))
  expect(screen.queryByTestId("session-row-a1")).toBeNull()
  expect(screen.getByLabelText("Active session").textContent).toBe("b2")
  fireEvent.click(screen.getByTestId("session-row-b1"))
  expect(screen.getByLabelText("Active session").textContent).toBe("b1")
  fireEvent.click(screen.getByRole("button", { name: "alpha" }))
  expect(screen.getByLabelText("Active session").textContent).toBe("a1")
  fireEvent.click(screen.getByRole("button", { name: "Update Alpha" }))
  fireEvent.click(screen.getByRole("button", { name: "beta" }))
  expect(screen.getByLabelText("Active session").textContent).toBe("b1")
})

it.each(["Archive Beta one", "Delete Beta one"])("falls back when the remembered session is unavailable: %s", (action) => {
  render(<Navigation />)
  fireEvent.click(screen.getByRole("button", { name: "beta" }))
  fireEvent.click(screen.getByTestId("session-row-b1"))
  fireEvent.click(screen.getByRole("button", { name: "alpha" }))
  fireEvent.click(screen.getByRole("button", { name: action }))
  fireEvent.click(screen.getByRole("button", { name: "beta" }))
  expect(screen.getByLabelText("Active session").textContent).toBe("b2")
})

it("shows an empty project instead of the previous project's conversation", () => {
  render(<Navigation showEmpty={false} />)
  expect(screen.getByTestId("session-content").textContent).toBe("a1")
  fireEvent.click(screen.getByRole("button", { name: "empty" }))
  expect(screen.getByLabelText("Selected project").textContent).toBe("empty")
  expect(screen.getByLabelText("Active session").textContent).toBe("a1")
  expect(screen.queryByTestId("session-content")).toBeNull()
  expect(screen.getByRole("heading", { name: "Start your first session" })).toBeTruthy()
})

it("routes Explorer files through the reveal callback", () => {
  const open = vi.fn()
  render(<SessionConversation projects={projects} sessions={sessions} activeSessionId="a1"
    onSelectSession={() => {}} onOpenExplorerFile={open}
    renderExplorer={(_session, onOpenPath) => <button type="button" onClick={() => onOpenPath("src/index.ts")}>index.ts</button>}
    showEmpty />)
  fireEvent.click(screen.getByRole("tab", { name: "Explorer" }))
  fireEvent.click(screen.getByRole("button", { name: "index.ts" }))
  expect(open).toHaveBeenCalledWith("a1", "src/index.ts")
})
