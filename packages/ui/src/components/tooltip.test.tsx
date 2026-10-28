import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Tooltip } from "./tooltip.js"

afterEach(cleanup)

describe("Tooltip", () => {
  it("opens from keyboard focus on a focusable wrapper around a disabled button", async () => {
    render(
      <Tooltip label="Branch is out of date">
        <span tabIndex={0} data-testid="wrap">
          <button type="button" disabled>Merge</button>
        </span>
      </Tooltip>
    )
    act(() => screen.getByTestId("wrap").focus())
    expect((await screen.findByRole("tooltip")).textContent).toBe("Branch is out of date")
  })
})
