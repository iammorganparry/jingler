import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ToolCall } from "./tool-call.js"

afterEach(cleanup)

const redIcons = (c: HTMLElement) => c.querySelectorAll("svg.text-state-failed")

describe("ToolCall", () => {
  it("shows a red icon only for a failed call", () => {
    const failed = render(<ToolCall status="error" name="Bash" target="pnpm test" meta="exit 1" />)
    expect(redIcons(failed.container)).toHaveLength(1)
    expect(failed.container.querySelector(".text-red")).toBeNull()
    cleanup()
    for (const status of ["success", "running"] as const) {
      const { container } = render(<ToolCall status={status} name="Read" target="a.ts" meta="3 lines" />)
      expect(redIcons(container)).toHaveLength(0)
      expect(container.querySelector("[data-tool-status]")?.getAttribute("data-tool-status")).toBe(status)
      cleanup()
    }
  })
})
