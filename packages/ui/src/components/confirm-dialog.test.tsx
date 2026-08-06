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
