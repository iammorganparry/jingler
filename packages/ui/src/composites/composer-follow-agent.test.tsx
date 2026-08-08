import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)

describe("Composer agent follow control", () => {
  it("renders an icon button that toggles the shared follow mode", () => {
    const onToggleFollowAgent = vi.fn()
    const { rerender } = render(
      <Composer followAgent={false} onToggleFollowAgent={onToggleFollowAgent} />
    )

    const follow = screen.getByRole("button", { name: "Follow agent" })
    expect(follow.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(follow)
    expect(onToggleFollowAgent).toHaveBeenCalledWith(true)

    rerender(<Composer followAgent onToggleFollowAgent={onToggleFollowAgent} />)
    expect(screen.getByRole("button", { name: "Follow agent" }).getAttribute("aria-pressed")).toBe(
      "true"
    )
  })

  it("omits the control when the host does not provide follow mode", () => {
    render(<Composer />)
    expect(screen.queryByRole("button", { name: "Follow agent" })).toBeNull()
  })
})
