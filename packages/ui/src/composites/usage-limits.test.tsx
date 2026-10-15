import { cleanup, render, screen } from "@testing-library/react"
import type { Usage } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import { UsageLimits } from "./usage-limits.js"

afterEach(cleanup)

const usage = (status: "ok" | "limited"): Usage => ({
  fetchedAt: null,
  providers: [
    {
      name: "Anthropic",
      plan: null,
      available: true,
      windows: [
        { label: "Current session", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), utilization: 100, status },
        { label: "Weekly · all models", resetsAt: null, utilization: 40, status: "ok" }
      ]
    }
  ]
})

describe("UsageLimits", () => {
  it("shows the reset time of a limited window", () => {
    render(<UsageLimits usage={usage("limited")} />)
    const [limited, ok] = screen.getAllByTestId("usage-limit-row")
    expect(limited!.textContent).toMatch(/Limited until \S+/)
    expect(limited!.getAttribute("data-limited")).toBe("true")
    expect(ok!.textContent).toContain("40% used")
  })

  it("does not tint rows with status colours", () => {
    render(<UsageLimits usage={usage("limited")} />)
    expect(screen.getByTestId("usage-limits").innerHTML).not.toMatch(/red|yellow|green|style=/)
  })

  it("labels the relay quota as a placeholder", () => {
    render(<UsageLimits usage={null} />)
    expect(screen.getByTestId("usage-relay-quota").textContent).toContain("placeholder")
    expect(screen.getByText("No limits reported.")).toBeTruthy()
  })
})
