import { describe, expect, it, vi } from "vitest"
import { needsYouToast } from "./needs-you-toast.js"

const blocked = { sessionId: "s1", title: "Session A", body: "Waiting for your input." }

describe("needsYouToast", () => {
  it("is suppressed for a session on screen", () => {
    expect(needsYouToast(blocked, true, () => {})).toBeNull()
  })

  it("builds a Jump toast for a background session", () => {
    const jump = vi.fn()
    const toast = needsYouToast(blocked, false, jump)
    expect(toast).toMatchObject({ variant: "needs-you", title: "Session A", sessionId: "s1" })
    toast?.action?.onAction()
    expect(jump).toHaveBeenCalledOnce()
  })
})
