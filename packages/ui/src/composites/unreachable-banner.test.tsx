import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { UnreachableBanner } from "./unreachable-banner.js"

afterEach(cleanup)

describe("UnreachableBanner", () => {
  it("is a neutral top notice that says the app keeps working locally", () => {
    render(<UnreachableBanner onRetry={() => {}} />)
    expect(screen.getByTestId("banner-message").textContent).toBe("Can't reach Jingler, you can keep working locally")
    expect(screen.getByTestId("banner-shell").getAttribute("role")).toBe("status")
    expect(screen.getByTestId("banner-shell").className).toContain("border-hairline")
  })

  it("Retry calls onRetry", () => {
    const onRetry = vi.fn()
    render(<UnreachableBanner onRetry={onRetry} />)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
