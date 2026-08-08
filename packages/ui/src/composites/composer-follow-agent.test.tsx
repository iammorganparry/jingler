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
    expect(follow.className).toContain("jingler-mode-toggle")
    expect(follow.className).not.toContain("is-active")
    expect(follow.querySelector("svg")?.getAttribute("class")).toContain(
      "jingler-mode-toggle__mark"
    )
    expect(follow.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-mouse-pointer-2"
    )

    fireEvent.click(follow)
    expect(onToggleFollowAgent).toHaveBeenCalledWith(true)

    rerender(<Composer followAgent onToggleFollowAgent={onToggleFollowAgent} />)
    const selectedFollow = screen.getByRole("button", { name: "Follow agent" })
    expect(selectedFollow.getAttribute("aria-pressed")).toBe("true")
    expect(selectedFollow.className).toContain("is-active")
  })

  it("omits the control when the host does not provide follow mode", () => {
    render(<Composer />)
    expect(screen.queryByRole("button", { name: "Follow agent" })).toBeNull()
  })
})
