import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
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
  expect(start).toHaveBeenCalledWith("fix it", undefined)
})
