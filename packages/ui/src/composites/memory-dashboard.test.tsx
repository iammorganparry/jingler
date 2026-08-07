import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryDashboard } from "./memory-dashboard.js"
import type { MemoryDashboardSummary } from "@jingler/contracts"

afterEach(cleanup)

const HEALTH_FINDINGS = /Health findings/
const PAGE_BODY = /page body/i

const summary: MemoryDashboardSummary = {
  version: 1,
  asOf: "2026-08-01T00:00:00.000Z",
  growth: { acceptedPages: 12, revisions: 18, sources: 7, daily: [{ day: "2026-08-01", pages: 2, revisions: 3 }] },
  citationCoverage: { citations: 20, citedPages: 10, totalPages: 12, ratio: 10 / 12 },
  freshness: { fresh: 8, aging: 2, stale: 2, unknown: 0 },
  health: { orphanPages: 1, brokenLinks: 2, contradictions: 1 },
  connectivity: { pages: 12, directedLinks: 20, connectedPages: 11, averageDegree: 3.3 },
  retrieval: {
    searches: 9,
    reads: 7,
    navigation: 3,
    graphReads: 2,
    proposals: 1,
    zeroResultSearches: 1,
    zeroResultRatio: 1 / 9,
    resultsReturned: 24,
    uniqueQueryHashes: 8,
    medianDurationMs: 6,
    p95DurationMs: 10
  }
}

describe("MemoryDashboard", () => {
  it("renders bounded summary data and deep-links quality cards", () => {
    const navigate = vi.fn()
    render(<MemoryDashboard summary={summary} onNavigate={navigate} />)
    expect(screen.getByText("12")).toBeDefined()
    expect(screen.getByText("83%")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: HEALTH_FINDINGS }))
    expect(navigate).toHaveBeenCalledWith({ view: "map", filter: "unhealthy" })
    expect(screen.queryByText(PAGE_BODY)).toBeNull()
  })
})
