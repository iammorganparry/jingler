import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)
it("reserves the spinner for submission, blocks mouse/Enter, and restores controlled text after failure", () => {
  const onSend = vi.fn()
  const onStop = vi.fn()
  const draft = { value: "Retained draft", onSend, onStop, preserveDraftOnSend: true }
  const rendered = render(<Composer {...draft} disabledReason="Loading models" />)
  expect(screen.queryByRole("button", { name: "Creating session" })).toBeNull()
  expect(screen.queryByText("Loading models")).not.toBeNull()
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
  expect(onSend).not.toHaveBeenCalled()
  rendered.rerender(<Composer {...draft} busy />)
  fireEvent.click(screen.getByRole("button", { name: "Stop" }))
  expect(onStop).toHaveBeenCalledOnce()
  rendered.rerender(<Composer {...draft} busy onStop={undefined} />)
  fireEvent.click(screen.getByRole("button", { name: "Queue ↵" }))
  expect(onSend).toHaveBeenCalledOnce()
  rendered.rerender(<Composer {...draft} submitting />)
  const spinner = screen.getByRole("button", { name: "Creating session" })
  expect(spinner.getAttribute("aria-busy")).toBe("true")
  expect(spinner).toHaveProperty("disabled", true)
  fireEvent.click(spinner)
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
  expect(onSend).toHaveBeenCalledOnce()
  rendered.rerender(<Composer {...draft} />)
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Retained draft")
  expect(screen.getByRole("button", { name: "Send ↵" }).getAttribute("aria-busy")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Send ↵" }))
  expect(onSend).toHaveBeenCalledTimes(2)
})
