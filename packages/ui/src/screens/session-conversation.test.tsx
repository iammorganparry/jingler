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
  testSession({ id: "b1", projectId: "beta", title: "Beta one" })
]

function Navigation() {
  const [active, setActive] = useState("a1")
  const [currentSessions, setCurrentSessions] = useState(sessions)
  return <>
    <output aria-label="Active session">{active}</output>
    <button type="button" onClick={() => setCurrentSessions((current) => current.map((session) =>
      session.id === "a1" ? { ...session, updatedAt: "2026-08-01T00:00:00.000Z" } : session
    ))}>Update Alpha</button>
    <SessionConversation projects={projects} sessions={currentSessions} activeSessionId={active}
      onSelectSession={setActive} showEmpty />
  </>
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it("keeps the selected project scoped until one of its sessions is selected", () => {
  render(<Navigation />)
  fireEvent.click(screen.getByRole("button", { name: "beta" }))
  expect(screen.queryByTestId("session-row-a1")).toBeNull()
  expect(screen.getByTestId("session-row-b1")).toBeTruthy()
  expect(screen.getByLabelText("Active session").textContent).toBe("a1")

  fireEvent.click(screen.getByRole("button", { name: "Update Alpha" }))
  expect(screen.getByTestId("session-row-b1")).toBeTruthy()

  fireEvent.click(screen.getByTestId("session-row-b1"))
  expect(screen.getByLabelText("Active session").textContent).toBe("b1")
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
