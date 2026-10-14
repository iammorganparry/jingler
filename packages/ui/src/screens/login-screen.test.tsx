import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LoginScreen, type LoginScreenProps } from "./login-screen.js"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const handlers = () => ({
  onGithub: vi.fn(),
  onGoogle: vi.fn(),
  onSendMagicLink: vi.fn(),
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onReset: vi.fn()
})

const renderLogin = (props: Partial<LoginScreenProps> = {}) => {
  const h = handlers()
  render(<LoginScreen embedded {...h} {...props} />)
  return h
}

describe("LoginScreen waiting", () => {
  it("shows the browser hand-off with Cancel and Copy sign-in link", () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const h = renderLogin({ state: "waiting", signInUrl: "https://example.com/in" })
    expect(screen.getByText(/Finish signing in in your browser/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /continue with github/i })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Copy sign-in link" }))
    expect(writeText).toHaveBeenCalledWith("https://example.com/in")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(h.onCancel).toHaveBeenCalledOnce()
  })

  it("offers Try again after 2 minutes", () => {
    vi.useFakeTimers()
    const h = renderLogin({ state: "waiting" })
    act(() => void vi.advanceTimersByTime(119_999))
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(h.onRetry).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })
})

describe("LoginScreen error", () => {
  it("shows the cause in state-failed with Retry and Use a different method", () => {
    const h = renderLogin({ state: "error", errorMessage: "Boom happened" })
    expect(screen.getByRole("alert").textContent).toBe("Boom happened")
    expect(screen.getByRole("alert").className).toContain("text-state-failed")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(h.onRetry).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Use a different method" }))
    expect(h.onReset).toHaveBeenCalledOnce()
  })
})

describe("LoginScreen sent", () => {
  it("confirms the address and resends with a 30s cooldown", () => {
    vi.useFakeTimers()
    const h = renderLogin({ state: "sent", sentEmail: "morgan@example.com" })
    expect(screen.getByText(/link\s+expires in 15 min/)).toBeTruthy()
    expect(screen.getByText("morgan@example.com")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Resend" }))
    expect(h.onSendMagicLink).toHaveBeenCalledWith("morgan@example.com", undefined)
    const sentAgain = screen.getByRole("button", { name: "Sent again ✓" })
    expect((sentAgain as HTMLButtonElement).disabled).toBe(true)
    act(() => void vi.advanceTimersByTime(29_999))
    expect(screen.queryByRole("button", { name: "Resend" })).toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    expect(screen.getByRole("button", { name: "Resend" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Use a different email" }))
    expect(h.onReset).toHaveBeenCalledOnce()
  })
})
