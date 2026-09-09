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

function Navigation({ onCreate = () => {} }: { onCreate?: (id: string) => void }) {
  const [active, setActive] = useState("a1")
  return <><output aria-label="Active session">{active}</output><SessionConversation projects={projects} sessions={sessions} activeSessionId={active}
    onSelectSession={setActive} onNewSessionForProject={onCreate} showEmpty /></>
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it("restores each project's remembered session", () => {
  render(<Navigation />)
  fireEvent.click(screen.getByTestId("session-row-a2"))
  expect(localStorage.getItem("jingler.project.last-session.alpha")).toBe("a2")
  fireEvent.click(screen.getByRole("button", { name: "beta" }))
  expect(screen.queryByTestId("session-row-a2")).toBeNull()
  expect(screen.getByTestId("session-row-b1")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "alpha" }))
  expect(screen.queryByTestId("session-row-b1")).toBeNull()
  expect(localStorage.getItem("jingler.project.last-session.alpha")).toBe("a2")
  expect(screen.getByLabelText("Active session").textContent).toBe("a2")
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

it("starts a session for an empty project", () => {
  const create = vi.fn()
  render(<Navigation onCreate={create} />)
  fireEvent.click(screen.getByRole("button", { name: "empty" }))
  expect(create).toHaveBeenCalledWith("empty")
  expect(screen.queryByTestId("session-row-a1")).toBeNull()
})
