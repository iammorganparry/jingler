import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Toast, ToastRegion } from "./toast.js"
import type { ToastItem } from "./toast-machine.js"

afterEach(cleanup)

const item = (key: string, extra: Partial<ToastItem> = {}): ToastItem => ({
  key,
  variant: "info",
  title: key,
  remainingMs: 6000,
  ...extra
})

describe("Toast", () => {
  it("announces errors assertively and everything else politely", () => {
    const { rerender } = render(<Toast variant="error" title="Push failed" onDismiss={() => {}} />)
    expect(screen.getByRole("alert").getAttribute("aria-live")).toBe("assertive")
    rerender(<Toast variant="success" title="Pushed" onDismiss={() => {}} />)
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite")
  })

  it("keeps success neutral: no green fill", () => {
    render(<Toast variant="success" title="Pushed" onDismiss={() => {}} />)
    expect(screen.getByRole("status").className).not.toMatch(/green/)
  })

  it("runs the action and the labelled dismiss button", () => {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    render(<Toast variant="error" title="Push failed" action={{ label: "Retry", onAction }} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }))
    expect(onAction).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe("ToastRegion", () => {
  it("pauses on hover and focus, resumes on leave, and Esc dismisses the newest", () => {
    const onDismiss = vi.fn()
    const onPause = vi.fn()
    const onResume = vi.fn()
    render(<ToastRegion toasts={[item("a"), item("b")]} onDismiss={onDismiss} onPause={onPause} onResume={onResume} />)
    const region = screen.getByRole("region", { name: "Notifications" })
    expect(region.getAttribute("aria-live")).toBe("polite")
    fireEvent.mouseEnter(region)
    expect(onPause).toHaveBeenCalledOnce()
    fireEvent.mouseLeave(region)
    expect(onResume).toHaveBeenCalledOnce()
    fireEvent.keyDown(region, { key: "Escape" })
    expect(onDismiss).toHaveBeenCalledWith("b")
  })
})
