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
        destructive
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

describe("ConfirmDialog destructive (spec §6.10)", () => {
  it("makes the destructive confirm the solid red button and focuses Cancel first", async () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="Discard changes?" confirmLabel="Discard" destructive onConfirm={() => {}} />)
    expect(screen.getByRole("button", { name: "Discard" }).className).toContain("bg-state-failed")
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })))
  })

  it("keeps a non-destructive confirm neutral", () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="Rename?" confirmLabel="Rename" onConfirm={() => {}} />)
    const confirm = screen.getByRole("button", { name: "Rename" })
    expect(confirm.className).toContain("bg-primary-fill")
    expect(confirm.className).not.toContain("bg-state-failed")
  })

  it("cancels on Esc", async () => {
    const onOpenChange = vi.fn()
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="Delete?" destructive onConfirm={() => {}} />)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("styles Cancel as the secondary button in both modes", () => {
    for (const destructive of [true, false]) {
      render(<ConfirmDialog open onOpenChange={() => {}} title="Sure?" destructive={destructive} onConfirm={() => {}} />)
      const cancel = screen.getByRole("button", { name: "Cancel" })
      expect(cancel.className).toContain("border-line-strong")
      expect(cancel.className).not.toContain("bg-state-failed")
      cleanup()
    }
  })

  it("cancels on Esc without confirming for a non-destructive dialog", async () => {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn()
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="Rename?" onConfirm={onConfirm} />)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
