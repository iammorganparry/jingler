import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { Usage } from "@jingler/core"
import { UsageModal } from "./usage-modal.js"

afterEach(cleanup)

const apiUsage = {
  fetchedAt: "2026-10-13T12:00:00.000Z",
  providers: [{
    name: "Claude",
    plan: "Enterprise · API pricing",
    available: true,
    billingRoute: "api",
    windows: [],
    spend: {
      lastSession: { tokens: 12_500, costUsd: 1.234 },
      today: { tokens: 2_000_000, costUsd: 4.5 },
      month: { tokens: 0, costUsd: 0 }
    }
  }]
} as unknown as Usage

describe("UsageModal", () => {
  it("shows spend with the API-pricing plan label and no percentage bars for an API-priced connection", () => {
    render(<UsageModal open usage={apiUsage} />)
    expect(screen.getByText("Enterprise · API pricing")).toBeTruthy()
    expect(screen.getByText("$1.23 · 13k tokens")).toBeTruthy()
    expect(screen.getByText("$4.50 · 2.0M tokens")).toBeTruthy()
    expect(screen.queryByText(/% used/)).toBeNull()
    expect(screen.queryByText(/isn't available/)).toBeNull()
  })
})
