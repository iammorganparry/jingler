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
