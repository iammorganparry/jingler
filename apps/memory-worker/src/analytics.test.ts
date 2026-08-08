import type { MemoryPage } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import { buildVaultDashboardSummary, type VaultAnalyticsInput } from "./analytics.js"

const pages: ReadonlyArray<MemoryPage> = [
  {
    id: "alpha",
    path: "alpha.md",
    title: "Alpha",
    revision: 2,
    aliases: [],
    tags: ["topic"],
    sources: [],
    citations: [{ id: "citation-1", sourceId: "source-1" }],
    relationships: [],
    body: "# Alpha\n\nA supported fact links to [[Beta]]. [@citation-1]\n",
    metadata: { contradictions: ["claim-a", "claim-b"] }
  },
  {
    id: "beta",
    path: "beta.md",
    title: "Beta",
    revision: 1,
    aliases: [],
    tags: [],
    sources: [],
    citations: [],
    relationships: [],
    body: "# Beta\n",
    metadata: { citationPolicy: "none" }
  },
  {
    id: "gamma",
    path: "gamma.md",
    title: "Gamma",
    revision: 1,
    aliases: [],
    tags: [],
    sources: [],
    citations: [],
    relationships: [],
    body: "# Gamma\n\nA stale reference points to [[Missing]].\n",
    metadata: { citationPolicy: "none" }
  }
]

describe("vault dashboard analytics", () => {
  it("exactly aggregates growth, coverage, freshness, health, connectivity, and retrieval", () => {
    const input: VaultAnalyticsInput = {
      pages,
      sourceCount: 1,
      revisions: [
        { id: "r1", pageId: "alpha", createdAt: "2026-01-01T00:00:00.000Z", acceptedAt: "2026-01-01T00:00:00.000Z" },
        { id: "r2", pageId: "alpha", createdAt: "2026-07-01T00:00:00.000Z", acceptedAt: "2026-07-01T00:00:00.000Z" },
        { id: "r3", pageId: "beta", createdAt: "2026-07-20T00:00:00.000Z", acceptedAt: "2026-07-20T00:00:00.000Z" },
        { id: "r4", pageId: "gamma", createdAt: "2026-06-01T00:00:00.000Z", acceptedAt: "2026-06-01T00:00:00.000Z" }
      ],
      heads: [
        { pageId: "alpha", acceptedAt: "2026-07-20T00:00:00.000Z" },
        { pageId: "beta", acceptedAt: "2026-01-01T00:00:00.000Z" },
        { pageId: "gamma", acceptedAt: "2026-06-01T00:00:00.000Z" }
      ],
      retrievals: [
        { id: "q1", occurredAt: "2026-07-01", queryHash: "hash-a", resultCount: 2, durationMs: 10 },
        { id: "q2", occurredAt: "2026-07-02", queryHash: "hash-b", resultCount: 0, durationMs: 30 },
        { id: "q3", occurredAt: "2026-07-03", queryHash: "hash-a", resultCount: 4, durationMs: 20 }
      ],
      sessionRetrievals: [
        {
          id: "session-retrieval:source-1",
          occurredAt: "2026-07-04",
          searches: 2,
          reads: 3,
          navigation: 1,
          graphReads: 4,
          proposals: 1
        }
      ]
    }
    expect(buildVaultDashboardSummary(input, "2026-08-01T00:00:00.000Z")).toEqual({
      version: 1,
      asOf: "2026-08-01T00:00:00.000Z",
      growth: {
        acceptedPages: 3,
        revisions: 4,
        sources: 1,
        daily: [
          { day: "2026-01-01", pages: 1, revisions: 1 },
          { day: "2026-06-01", pages: 1, revisions: 1 },
          { day: "2026-07-01", pages: 0, revisions: 1 },
          { day: "2026-07-20", pages: 1, revisions: 1 }
        ]
      },
      citationCoverage: { citations: 1, citedPages: 1, totalPages: 3, ratio: 0.3333 },
      freshness: { fresh: 1, aging: 1, stale: 1, unknown: 0 },
      health: { orphanPages: 1, brokenLinks: 1, contradictions: 2 },
      reviewThroughput: {
        proposed: 0,
        accepted: 0,
        rejected: 0,
        conflicted: 0,
        open: 0,
        acceptanceRatio: 0,
        medianReviewHours: null
      },
      connectivity: { pages: 3, directedLinks: 1, connectedPages: 2, averageDegree: 0.6667 },
      retrieval: {
        searches: 5,
        reads: 3,
        navigation: 1,
        graphReads: 4,
        proposals: 1,
        zeroResultSearches: 1,
        zeroResultRatio: 0.3333,
        resultsReturned: 6,
        uniqueQueryHashes: 2,
        medianDurationMs: 20,
        p95DurationMs: 30
      }
    })
  })

  it("windows time-scoped series by the selected range relative to asOf", () => {
    const asOf = "2026-08-01T00:00:00.000Z"
    const input: VaultAnalyticsInput = {
      pages,
      sourceCount: 2,
      revisions: [
        { id: "r-old", pageId: "alpha", createdAt: "2026-01-01T00:00:00.000Z", acceptedAt: "2026-01-01T00:00:00.000Z" },
        { id: "r-90", pageId: "alpha", createdAt: "2026-05-20T00:00:00.000Z", acceptedAt: "2026-05-20T00:00:00.000Z" },
        { id: "r-30", pageId: "beta", createdAt: "2026-07-10T00:00:00.000Z", acceptedAt: "2026-07-10T00:00:00.000Z" },
        { id: "r-7", pageId: "gamma", createdAt: "2026-07-28T00:00:00.000Z", acceptedAt: "2026-07-28T00:00:00.000Z" }
      ],
      heads: [],
      retrievals: [
        { id: "m-old", occurredAt: "2026-02-01T00:00:00.000Z", queryHash: "h1", resultCount: 1, durationMs: 5 },
        { id: "m-7", occurredAt: "2026-07-30T00:00:00.000Z", queryHash: "h2", resultCount: 3, durationMs: 9 }
      ]
    }

    const all = buildVaultDashboardSummary(input, asOf, "all")
    const ninety = buildVaultDashboardSummary(input, asOf, "90d")
    const thirty = buildVaultDashboardSummary(input, asOf, "30d")
    const seven = buildVaultDashboardSummary(input, asOf, "7d")

    // "all" is unwindowed and identical to the default (no range) call.
    expect(all).toEqual(buildVaultDashboardSummary(input, asOf))
    expect(all.growth.revisions).toBe(4)
    expect(all.retrieval.searches).toBe(2)

    // Each narrower window drops older time-series entries; current-state stays constant.
    expect(ninety.growth.revisions).toBe(3)
    expect(thirty.growth.revisions).toBe(2)
    expect(seven.growth.revisions).toBe(1)
    expect(seven.retrieval.searches).toBe(1)
    // Snapshot metrics (current pages) are never windowed.
    expect(seven.growth.acceptedPages).toBe(all.growth.acceptedPages)
    expect(seven.citationCoverage).toEqual(all.citationCoverage)
    expect(seven.connectivity).toEqual(all.connectivity)
  })

  it("buckets growth by acceptedAt, not createdAt, when they fall on different days", () => {
    const input: VaultAnalyticsInput = {
      pages: [],
      sourceCount: 0,
      // Drafted 2026-07-01, accepted 2026-07-05: growth must land on the ACCEPTANCE
      // day, since the documented metric is accepted-event-time.
      revisions: [
        { id: "r1", pageId: "alpha", createdAt: "2026-07-01T00:00:00.000Z", acceptedAt: "2026-07-05T00:00:00.000Z" },
        { id: "r2", pageId: "alpha", createdAt: "2026-07-02T00:00:00.000Z", acceptedAt: "2026-07-05T12:00:00.000Z" }
      ],
      heads: [],
      retrievals: []
    }
    const summary = buildVaultDashboardSummary(input, "2026-08-01T00:00:00.000Z")
    // A single acceptance-day bucket (07-05), with the page counted new on that day —
    // NOT split across the two authoring days (07-01 / 07-02).
    expect(summary.growth.daily).toEqual([{ day: "2026-07-05", pages: 1, revisions: 2 }])
  })

  it("counts a page linked only via a dependency as connected, not an orphan", () => {
    const dependant: MemoryPage = {
      id: "dependant",
      path: "dependant.md",
      title: "Dependant",
      revision: 1,
      aliases: [],
      tags: [],
      sources: [],
      citations: [],
      relationships: [{ kind: "dependency", target: "Target" }],
      body: "# Dependant\n\nNo wikilinks here.\n",
      metadata: { citationPolicy: "none" }
    }
    const target: MemoryPage = {
      id: "target",
      path: "target.md",
      title: "Target",
      revision: 1,
      aliases: [],
      tags: [],
      sources: [],
      citations: [],
      relationships: [],
      body: "# Target\n\nAlso no wikilinks.\n",
      metadata: { citationPolicy: "none" }
    }
    const input: VaultAnalyticsInput = {
      pages: [dependant, target],
      sourceCount: 0,
      revisions: [],
      heads: [],
      retrievals: []
    }
    const summary = buildVaultDashboardSummary(input, "2026-08-01T00:00:00.000Z")
    // The dependency edge connects BOTH endpoints — neither is an orphan, matching
    // the graph view's degree-based definition.
    expect(summary.health.orphanPages).toBe(0)
    expect(summary.connectivity.connectedPages).toBe(2)
    expect(summary.connectivity.directedLinks).toBe(1)
  })
})
