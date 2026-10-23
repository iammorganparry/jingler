import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { Project } from "@jingler/core"
import { EmptyConversation, greetingFor } from "./empty-conversation.js"

afterEach(cleanup)

it("greets by time of day and first name, and drops the name when signed out", () => {
  expect(greetingFor(new Date(2026, 0, 1, 9), "Morgan")).toBe("Good morning, Morgan")
  expect(greetingFor(new Date(2026, 0, 1, 14), "Morgan")).toBe("Good afternoon, Morgan")
  expect(greetingFor(new Date(2026, 0, 1, 20))).toBe("Good evening")
})

it("shows the first-run starters and submits the prompt with ⌘↵", () => {
  const start = vi.fn()
  render(<EmptyConversation sessions={[]} liveActivity={{}} onOpenSession={() => {}} onStartWithPrompt={start} userName="Morgan Parry" now={new Date(2026, 0, 1, 9)} />)
  expect(screen.getByRole("heading", { name: "Good morning, Morgan" })).toBeTruthy()
  for (const label of ["Start from a GitHub issue", "Start from a PR", "Describe a task"]) {
    expect(screen.getByRole("button", { name: label })).toBeTruthy()
  }
  const box = screen.getByRole("textbox", { name: "What should we build?" })
  fireEvent.change(box, { target: { value: "fix it" } })
  fireEvent.keyDown(box, { key: "Enter", metaKey: true })
  expect(start).toHaveBeenCalledWith({ draft: "fix it", projectId: undefined, isolation: "worktree" })
})

const project = { id: "p1", name: "jingler", path: "/repo" } as Project
const withProject = (start: () => void) => (
  <EmptyConversation sessions={[]} liveActivity={{}} onOpenSession={() => {}} onStartWithPrompt={start} projects={[project]} loadBranches={async () => ["dev", "main"]} />
)

it("shows project · from · checkout chips and passes their values on submit", async () => {
  const start = vi.fn()
  render(withProject(start))
  expect(screen.getByRole("button", { name: "Project" })).toBeTruthy()
  expect(await screen.findByRole("button", { name: "Start from" })).toBeTruthy()
  expect((await screen.findByText("from main"))).toBeTruthy()
  expect(screen.getByRole("button", { name: "Checkout" })).toBeTruthy()
  const box = screen.getByRole("textbox", { name: "What should we build?" })
  fireEvent.change(box, { target: { value: "go" } })
  fireEvent.keyDown(box, { key: "Enter", metaKey: true })
  expect(start).toHaveBeenCalledWith({ draft: "go", projectId: "p1", baseBranch: "main", isolation: "worktree" })
})

it("preselects the source for the PR and issue starters", async () => {
  const start = vi.fn()
  render(withProject(start))
  await screen.findByText("from main")
  fireEvent.click(screen.getByRole("button", { name: "Start from a PR" }))
  expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ source: "pr", projectId: "p1" }))
  fireEvent.click(screen.getByRole("button", { name: "Start from a GitHub issue" }))
  expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ source: "github", projectId: "p1" }))
})

it("sends from the shared Composer's send button with the draft and chip choices", async () => {
  const start = vi.fn()
  render(withProject(start))
  await screen.findByText("from main")
  fireEvent.change(screen.getByRole("textbox", { name: "What should we build?" }), { target: { value: "ship it" } })
  fireEvent.click(screen.getByRole("button", { name: "Send ↵" }))
  expect(start).toHaveBeenCalledWith({ draft: "ship it", projectId: "p1", baseBranch: "main", isolation: "worktree" })
})
