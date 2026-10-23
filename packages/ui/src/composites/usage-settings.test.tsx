import { cleanup, render, screen } from "@testing-library/react"
import type { Usage } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import { UsageSettings } from "./usage-settings.js"

afterEach(cleanup)

const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
const usage = {
  fetchedAt: new Date().toISOString(),
  providers: [
    {
      providerId: "anthropic",
      name: "Claude",
      plan: "Max",
      available: true,
      windows: [
        { label: "Current session", utilization: 40, resetsAt, status: "ok" },
        { label: "Weekly", utilization: 80, resetsAt, status: "nearing" }
      ]
    }
  ]
} as unknown as Usage

describe("UsageSettings", () => {
  it("renders each window with its reset time", () => {
    render(<UsageSettings usage={usage} />)
    expect(screen.getByText("Current session")).toBeTruthy()
    expect(screen.getByText("Weekly")).toBeTruthy()
    expect(screen.getAllByText(/^Resets /)).toHaveLength(2)
    expect(screen.getByText("40% used")).toBeTruthy()
  })
})
