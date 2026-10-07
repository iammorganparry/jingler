import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfirmDialog } from "./confirm-dialog.js"

afterEach(cleanup)

describe("ConfirmDialog", () => {
  it("keeps destructive actions open and disabled while they are pending", async () => {
    let finish = () => {}
    const confirm = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete session?"
        confirmLabel="Delete"
        tone="danger"
        onConfirm={confirm}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    const pending = screen.getByRole("button", { name: "Delete…" })
    expect(pending.getAttribute("aria-busy")).toBe("true")
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)

    finish()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

it("leaves closing to the machine after a synchronous confirmation", async () => {
  const onOpenChange = vi.fn()
  const confirm = vi.fn()
  render(<ConfirmDialog open title="Archive failed" confirmLabel="Retry" closeOnConfirm={false} onConfirm={confirm} onOpenChange={onOpenChange} />)
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(onOpenChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
