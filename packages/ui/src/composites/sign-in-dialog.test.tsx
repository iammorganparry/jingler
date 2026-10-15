import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SignInDialog, type SignInDialogProps } from "./sign-in-dialog.js"

afterEach(cleanup)

const renderDialog = (props: Partial<SignInDialogProps> = {}) => {
  const onOpenChange = vi.fn()
  render(
    <SignInDialog
      open
      onOpenChange={onOpenChange}
      onGithub={vi.fn()}
      onGoogle={vi.fn()}
      onSendMagicLink={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
      onReset={vi.fn()}
      {...props}
    />
  )
  return { onOpenChange }
}

describe("SignInDialog", () => {
  it("renders nothing when closed", () => {
    renderDialog({ open: false })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("shows the sign-in options in the default state", () => {
    renderDialog()
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Sign in to Jingler" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeTruthy()
  })

  it("shows the waiting, sent and error states", () => {
    renderDialog({ state: "waiting" })
    expect(screen.getByText(/finish signing in in your browser/i)).toBeTruthy()
    cleanup()
    renderDialog({ state: "sent", sentEmail: "a@b.co" })
    expect(screen.getByText("a@b.co")).toBeTruthy()
    cleanup()
    renderDialog({ state: "error", errorMessage: "nope" })
    expect(screen.getByRole("alert").textContent).toBe("nope")
  })

  it("dismisses on Escape", () => {
    const { onOpenChange } = renderDialog()
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
