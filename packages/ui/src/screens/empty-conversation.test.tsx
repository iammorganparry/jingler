import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { EmptyConversation, greetingFor } from "./empty-conversation.js"

afterEach(cleanup)

it("greets by time of day and first name, and drops the name when signed out", () => {
  expect(greetingFor(new Date(2026, 0, 1, 9), "Morgan")).toBe("Good morning, Morgan")
  expect(greetingFor(new Date(2026, 0, 1, 14), "Morgan")).toBe("Good afternoon, Morgan")
  expect(greetingFor(new Date(2026, 0, 1, 20))).toBe("Good evening")
})

it("hosts the New session composer it is given", () => {
  render(<EmptyConversation sessions={[]} composer={<textarea aria-label="What should we build?" />} userName="Morgan Parry" now={new Date(2026, 0, 1, 9)} />)
  expect(screen.getByRole("heading", { name: "Good morning, Morgan" })).toBeTruthy()
  expect(screen.getByRole("textbox", { name: "What should we build?" })).toBeTruthy()
})

it("first-run starters preselect a source, and Describe a task focuses the composer", () => {
  const startFrom = vi.fn()
  render(<EmptyConversation sessions={[]} composer={<textarea aria-label="What should we build?" />} onStartFrom={startFrom} />)
  fireEvent.click(screen.getByRole("button", { name: "Start from a PR" }))
  expect(startFrom).toHaveBeenLastCalledWith("pr")
  fireEvent.click(screen.getByRole("button", { name: "Start from a GitHub issue" }))
  expect(startFrom).toHaveBeenLastCalledWith("github")
  fireEvent.click(screen.getByRole("button", { name: "Describe a task" }))
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "What should we build?" }))
})

it("hides the starters once there are sessions", () => {
  render(<EmptyConversation sessions={[{ id: "s", archived: false } as never]} composer={null} />)
  expect(screen.queryByTestId("home-starters")).toBeNull()
})
