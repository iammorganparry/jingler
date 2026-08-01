import {
  buildIdentityIndex,
  extractCitationReferences,
  extractWikiLinks,
  resolveWikiLink,
  type MemoryAuditEvent,
  type MemoryPage,
  type MemoryProposalStatus
} from "@jingler/memory"
import type { MemoryRetrievalSummary } from "@jingler/core"

export interface VaultAnalyticsRevision {
  readonly id: string
  readonly pageId: string
  readonly createdAt: string
}

export interface VaultAnalyticsProposal {
  readonly id: string
  readonly createdAt: string
  readonly status: MemoryProposalStatus
}

export interface VaultPageHeadActivity {
  readonly pageId: string
  readonly acceptedAt: string
}

export interface RetrievalMetric {
  readonly id: string
  readonly occurredAt: string
  readonly queryHash: string
  readonly resultCount: number
  readonly durationMs: number
}

export interface SessionRetrievalMetric extends MemoryRetrievalSummary {
  readonly id: string
  readonly occurredAt: string
}

export interface VaultAnalyticsInput {
  readonly pages: ReadonlyArray<MemoryPage>
  readonly sourceCount: number
  readonly revisions: ReadonlyArray<VaultAnalyticsRevision>
  readonly proposals: ReadonlyArray<VaultAnalyticsProposal>
  readonly events: ReadonlyArray<MemoryAuditEvent>
  readonly heads: ReadonlyArray<VaultPageHeadActivity>
  readonly retrievals: ReadonlyArray<RetrievalMetric>
  readonly sessionRetrievals?: ReadonlyArray<SessionRetrievalMetric>
}

export interface DailyGrowth {
  readonly day: string
  readonly pages: number
  readonly revisions: number
}

export interface VaultDashboardSummary {
  readonly version: 1
  readonly asOf: string
  readonly growth: {
    readonly acceptedPages: number
    readonly revisions: number
    readonly sources: number
    readonly daily: ReadonlyArray<DailyGrowth>
  }
  readonly citationCoverage: {
    readonly citations: number
    readonly citedPages: number
    readonly totalPages: number
    readonly ratio: number
  }
  readonly freshness: {
    readonly fresh: number
    readonly aging: number
    readonly stale: number
    readonly unknown: number
  }
  readonly health: {
    readonly orphanPages: number
    readonly brokenLinks: number
    readonly contradictions: number
  }
  readonly reviewThroughput: {
    readonly proposed: number
    readonly accepted: number
    readonly rejected: number
    readonly conflicted: number
    readonly open: number
    readonly acceptanceRatio: number
    readonly medianReviewHours: number | null
  }
  readonly connectivity: {
    readonly pages: number
    readonly directedLinks: number
    readonly connectedPages: number
    readonly averageDegree: number
  }
  readonly retrieval: {
    readonly searches: number
    readonly reads: number
    readonly navigation: number
    readonly graphReads: number
    readonly proposals: number
    readonly zeroResultSearches: number
    readonly zeroResultRatio: number
    readonly resultsReturned: number
    readonly uniqueQueryHashes: number
    readonly medianDurationMs: number | null
    readonly p95DurationMs: number | null
  }
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const rounded = (value: number): number => Math.round(value * 10_000) / 10_000

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : rounded(numerator / denominator)

const dayOf = (timestamp: string): string => timestamp.slice(0, 10)

const percentile = (values: ReadonlyArray<number>, position: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(position * sorted.length) - 1))
  return sorted[index] ?? null
}

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper === undefined) return null
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? upper) + upper) / 2
}

const contradictionCount = (page: MemoryPage): number => {
  const value = page.metadata.contradictions
  if (Array.isArray(value)) return value.length
  return typeof value === "number" && value > 0 ? Math.floor(value) : 0
}

const freshnessCounts = (
  pages: ReadonlyArray<MemoryPage>,
  heads: ReadonlyArray<VaultPageHeadActivity>,
  asOf: string
): VaultDashboardSummary["freshness"] => {
  const acceptedAt = new Map(heads.map((head) => [head.pageId, head.acceptedAt]))
  const counts = { fresh: 0, aging: 0, stale: 0, unknown: 0 }
  for (const page of pages) {
    const timestamp = acceptedAt.get(page.id)
    const age = timestamp === undefined ? Number.NaN : Date.parse(asOf) - Date.parse(timestamp)
    if (!Number.isFinite(age)) counts.unknown += 1
    else if (age / 86_400_000 <= 30) counts.fresh += 1
    else if (age / 86_400_000 <= 90) counts.aging += 1
    else counts.stale += 1
  }
  return counts
}

const growthSeries = (
  revisions: ReadonlyArray<VaultAnalyticsRevision>
): ReadonlyArray<DailyGrowth> => {
  const pageFirstRevision = new Map<string, VaultAnalyticsRevision>()
  for (const revision of [...revisions].sort((left, right) => compareText(left.createdAt, right.createdAt))) {
    if (!pageFirstRevision.has(revision.pageId)) pageFirstRevision.set(revision.pageId, revision)
  }
  const counts = new Map<string, { pages: number; revisions: number }>()
  for (const revision of revisions) {
    const day = dayOf(revision.createdAt)
    const current = counts.get(day) ?? { pages: 0, revisions: 0 }
    current.revisions += 1
    counts.set(day, current)
  }
  for (const revision of pageFirstRevision.values()) {
    const day = dayOf(revision.createdAt)
    const current = counts.get(day) ?? { pages: 0, revisions: 0 }
    current.pages += 1
    counts.set(day, current)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([day, count]) => ({ day, ...count }))
}

const connectivity = (
  pages: ReadonlyArray<MemoryPage>
): {
  readonly directedLinks: number
  readonly connectedPages: number
  readonly orphanPages: number
  readonly brokenLinks: number
} => {
  const connected = new Set<string>()
  const identities = buildIdentityIndex(pages)
  let directedLinks = 0
  let brokenLinks = 0
  for (const page of pages) {
    for (const link of extractWikiLinks(page.body)) {
      const target = link.target === "" ? page : resolveWikiLink(link.target, identities)
      if (target === undefined) {
        brokenLinks += 1
        continue
      }
      directedLinks += 1
      connected.add(page.id)
      connected.add(target.id)
    }
  }
  return {
    directedLinks,
    connectedPages: connected.size,
    orphanPages: pages.length - connected.size,
    brokenLinks
  }
}

const reviewDurations = (
  proposals: ReadonlyArray<VaultAnalyticsProposal>,
  events: ReadonlyArray<MemoryAuditEvent>
): ReadonlyArray<number> => {
  const proposedAt = new Map(proposals.map((proposal) => [proposal.id, proposal.createdAt]))
  return events
    .filter(
      (event) =>
        (event.type === "proposal.accepted" || event.type === "proposal.rejected") &&
        event.proposalId !== undefined
    )
    .map((event) => {
      const createdAt = event.proposalId === undefined ? undefined : proposedAt.get(event.proposalId)
      return createdAt === undefined ? Number.NaN : Date.parse(event.occurredAt) - Date.parse(createdAt)
    })
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .map((duration) => duration / 3_600_000)
}

export const buildVaultDashboardSummary = (
  input: VaultAnalyticsInput,
  asOf: string
): VaultDashboardSummary => {
  const citationsByPage = input.pages.map((page) => extractCitationReferences(page.body).length)
  const links = connectivity(input.pages)
  const accepted = input.proposals.filter((proposal) => proposal.status === "accepted").length
  const rejected = input.proposals.filter((proposal) => proposal.status === "rejected").length
  const conflicted = input.proposals.filter((proposal) => proposal.status === "superseded").length
  const open = input.proposals.filter((proposal) => proposal.status === "open").length
  const durations = reviewDurations(input.proposals, input.events)
  const resultCount = input.retrievals.reduce((total, metric) => total + metric.resultCount, 0)
  const zeroResults = input.retrievals.filter((metric) => metric.resultCount === 0).length
  const captured = (input.sessionRetrievals ?? []).reduce<MemoryRetrievalSummary>(
    (total, metric) => ({
      searches: total.searches + metric.searches,
      reads: total.reads + metric.reads,
      navigation: total.navigation + metric.navigation,
      graphReads: total.graphReads + metric.graphReads,
      proposals: total.proposals + metric.proposals
    }),
    { searches: 0, reads: 0, navigation: 0, graphReads: 0, proposals: 0 }
  )
  return {
    version: 1,
    asOf,
    growth: {
      acceptedPages: input.pages.length,
      revisions: input.revisions.length,
      sources: input.sourceCount,
      daily: growthSeries(input.revisions)
    },
    citationCoverage: {
      citations: citationsByPage.reduce((total, count) => total + count, 0),
      citedPages: citationsByPage.filter((count) => count > 0).length,
      totalPages: input.pages.length,
      ratio: ratio(citationsByPage.filter((count) => count > 0).length, input.pages.length)
    },
    freshness: freshnessCounts(input.pages, input.heads, asOf),
    health: {
      orphanPages: links.orphanPages,
      brokenLinks: links.brokenLinks,
      contradictions: input.pages.reduce((total, page) => total + contradictionCount(page), 0)
    },
    reviewThroughput: {
      proposed: input.proposals.length,
      accepted,
      rejected,
      conflicted,
      open,
      acceptanceRatio: ratio(accepted, accepted + rejected + conflicted),
      medianReviewHours: median(durations)
    },
    connectivity: {
      pages: input.pages.length,
      directedLinks: links.directedLinks,
      connectedPages: links.connectedPages,
      averageDegree: input.pages.length === 0 ? 0 : rounded((links.directedLinks * 2) / input.pages.length)
    },
    retrieval: {
      searches: input.retrievals.length + captured.searches,
      reads: captured.reads,
      navigation: captured.navigation,
      graphReads: captured.graphReads,
      proposals: captured.proposals,
      zeroResultSearches: zeroResults,
      zeroResultRatio: ratio(zeroResults, input.retrievals.length),
      resultsReturned: resultCount,
      uniqueQueryHashes: new Set(input.retrievals.map((metric) => metric.queryHash)).size,
      medianDurationMs: median(input.retrievals.map((metric) => metric.durationMs)),
      p95DurationMs: percentile(
        input.retrievals.map((metric) => metric.durationMs),
        0.95
      )
    }
  }
}
