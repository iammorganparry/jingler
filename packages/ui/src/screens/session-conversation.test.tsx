import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { testSession } from "../test-support.js"
import { SessionConversation } from "./session-conversation.js"

const projects: Project[] = ["alpha", "beta"].map((id) => ({
  id, name: id, path: `/repos/${id}`, availability: id === "beta" ? "missing" : "available",
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
}))
const sessions = [
  testSession({ id: "a1", projectId: "alpha", repoPath: "/repos/alpha", title: "Alpha one" }),
  testSession({ id: "b1", projectId: "beta", repoPath: "/repos/beta", title: "Beta one" }),
  testSession({
    id: "ab",
    title: "Both",
    checkouts: [
      { id: "a", projectId: "alpha", repo: "alpha", repoPath: "/repos/alpha", branch: "b", prNumber: null },
      { id: "b", projectId: "beta", repo: "beta", repoPath: "/repos/beta", branch: "b", prNumber: null }
    ],
    activeCheckoutId: "a"
  })
]

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it("lists every workspace in one flat list, with no project rail", () => {
  render(<SessionConversation projects={projects} sessions={sessions} activeSessionId="a1" onSelectSession={() => {}} showEmpty />)
  expect(screen.queryByTestId("project-sidebar")).toBeNull()
  for (const id of ["a1", "b1", "ab"]) expect(screen.getByTestId(`session-row-${id}`)).toBeDefined()
})

it("marks a multi-repo workspace's chip when that repo's folder is missing", () => {
  render(<SessionConversation projects={projects} sessions={sessions} activeSessionId="a1" onSelectSession={() => {}} showEmpty />)
  expect(screen.getByTestId("repo-chip-beta").dataset.missing).toBe("true")
  expect(screen.getByTestId("repo-chip-alpha").dataset.missing).toBeUndefined()
})

it("shows the missing-folder banner only for the active workspace's missing repo", () => {
  const { rerender } = render(<SessionConversation projects={projects} sessions={sessions} activeSessionId="a1" onSelectSession={() => {}} onLocateProject={() => {}} showEmpty />)
  expect(screen.queryByText("beta: folder not found")).toBeNull()
  rerender(<SessionConversation projects={projects} sessions={sessions} activeSessionId="b1" onSelectSession={() => {}} onLocateProject={() => {}} showEmpty />)
  expect(screen.getByText("beta: folder not found")).toBeDefined()
})

it("starts a new workspace in the active workspace's repo", () => {
  const forProject = vi.fn()
  render(<SessionConversation projects={projects} sessions={sessions} activeSessionId="a1" onSelectSession={() => {}} onNewSessionForProject={forProject} showEmpty />)
  fireEvent.click(screen.getAllByTestId("new-session")[0]!)
  expect(forProject).toHaveBeenCalledWith("alpha")
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
