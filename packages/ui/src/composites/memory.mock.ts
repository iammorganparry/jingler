import type {
  MemoryDashboardSummary,
  MemoryEdgeEvidence,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphView,
  MemoryPageDetail,
  MemorySearchResult,
  MemorySuggestion
} from "@jingler/contracts"
import type {
  MemoryMapFilters,
  MemoryNodePosition,
  MemoryViewport
} from "./memory-map.js"

/**
 * Deterministic, realistic fixtures for the Memory feature's Storybook stories.
 *
 * Everything here is hand-authored and fixed — no `Date.now()`, no `Math.random()`
 * — so visual snapshots stay stable and the same vault renders identically across
 * every composite. The data models a small-org knowledge base with four topic
 * clusters (billing, infrastructure, auth, onboarding), a handful of health
 * findings, and advisory relatedness suggestions with embedding evidence.
 *
 * These fixtures are typed against the real `@jingler/contracts` schemas — no
 * `as`/`as any` casts — so a contract change surfaces here as a type error.
 */

// ---------------------------------------------------------------------------
// Topic clusters
// ---------------------------------------------------------------------------

const TOPIC_BILLING = "topic-billing"
const TOPIC_INFRA = "topic-infra"
const TOPIC_AUTH = "topic-auth"
const TOPIC_ONBOARDING = "topic-onboarding"

// ---------------------------------------------------------------------------
// Graph nodes
// ---------------------------------------------------------------------------

const node = (
  init: {
    id: string
    kind: MemoryGraphNode["kind"]
    title: string
    topicId?: string
    incoming: number
    outgoing: number
    freshness: MemoryGraphNode["freshness"]
    brokenLinks?: number
    contradictions?: number
    orphan?: boolean
  }
): MemoryGraphNode => ({
  id: init.id,
  kind: init.kind,
  title: init.title,
  ...(init.kind === "page" ? { pageId: init.id } : {}),
  ...(init.kind === "source" ? { sourceId: init.id } : {}),
  ...(init.kind === "schema" ? { schemaId: init.id } : {}),
  ...(init.topicId ? { topicId: init.topicId } : {}),
  degree: { incoming: init.incoming, outgoing: init.outgoing },
  freshness: init.freshness,
  health: {
    brokenLinks: init.brokenLinks ?? 0,
    contradictions: init.contradictions ?? 0,
    orphan: init.orphan ?? false
  }
})

const memoryGraphNodes: ReadonlyArray<MemoryGraphNode> = [
  // Billing & payments
  node({ id: "page-billing-overview", kind: "page", title: "Billing overview", topicId: TOPIC_BILLING, incoming: 3, outgoing: 4, freshness: "fresh" }),
  node({ id: "page-billing-invoices", kind: "page", title: "Invoice generation", topicId: TOPIC_BILLING, incoming: 2, outgoing: 3, freshness: "fresh" }),
  node({ id: "page-billing-dunning", kind: "page", title: "Dunning & retries", topicId: TOPIC_BILLING, incoming: 2, outgoing: 1, freshness: "aging" }),
  node({ id: "source-stripe", kind: "source", title: "Stripe API reference", topicId: TOPIC_BILLING, incoming: 5, outgoing: 0, freshness: "fresh" }),
  node({ id: "schema-invoice", kind: "schema", title: "Invoice schema", topicId: TOPIC_BILLING, incoming: 1, outgoing: 2, freshness: "fresh" }),
  node({ id: "page-billing-taxes", kind: "page", title: "Tax handling", topicId: TOPIC_BILLING, incoming: 2, outgoing: 2, freshness: "fresh" }),

  // Infrastructure
  node({ id: "page-infra-deploy", kind: "page", title: "Deployment pipeline", topicId: TOPIC_INFRA, incoming: 4, outgoing: 3, freshness: "fresh" }),
  node({ id: "page-infra-observability", kind: "page", title: "Observability stack", topicId: TOPIC_INFRA, incoming: 2, outgoing: 2, freshness: "aging" }),
  node({ id: "page-infra-incident", kind: "page", title: "Incident runbook", topicId: TOPIC_INFRA, incoming: 1, outgoing: 1, freshness: "stale", brokenLinks: 1 }),
  node({ id: "source-terraform", kind: "source", title: "Terraform modules", topicId: TOPIC_INFRA, incoming: 3, outgoing: 0, freshness: "fresh" }),
  node({ id: "page-infra-secrets", kind: "page", title: "Secrets management", topicId: TOPIC_INFRA, incoming: 2, outgoing: 2, freshness: "fresh" }),

  // Authentication
  node({ id: "page-auth-overview", kind: "page", title: "Auth architecture", topicId: TOPIC_AUTH, incoming: 5, outgoing: 4, freshness: "fresh" }),
  node({ id: "page-auth-oauth", kind: "page", title: "OAuth providers", topicId: TOPIC_AUTH, incoming: 3, outgoing: 2, freshness: "fresh" }),
  node({ id: "page-auth-sessions", kind: "page", title: "Session lifecycle", topicId: TOPIC_AUTH, incoming: 2, outgoing: 2, freshness: "aging", contradictions: 1 }),
  node({ id: "schema-session", kind: "schema", title: "Session schema", topicId: TOPIC_AUTH, incoming: 1, outgoing: 3, freshness: "fresh" }),
  node({ id: "source-betterauth", kind: "source", title: "BetterAuth reference", topicId: TOPIC_AUTH, incoming: 4, outgoing: 0, freshness: "fresh" }),

  // Onboarding
  node({ id: "page-onboarding-flow", kind: "page", title: "Onboarding flow", topicId: TOPIC_ONBOARDING, incoming: 3, outgoing: 3, freshness: "fresh" }),
  node({ id: "page-onboarding-invites", kind: "page", title: "Team invites", topicId: TOPIC_ONBOARDING, incoming: 2, outgoing: 1, freshness: "aging" }),
  node({ id: "page-onboarding-checklist", kind: "page", title: "Setup checklist", topicId: TOPIC_ONBOARDING, incoming: 1, outgoing: 0, freshness: "stale" }),

  // Orphaned / unhealthy island
  node({ id: "page-orphan-legacy", kind: "page", title: "Legacy migration notes", incoming: 0, outgoing: 0, freshness: "stale", brokenLinks: 2, contradictions: 1, orphan: true })
]

// ---------------------------------------------------------------------------
// Graph edges
// ---------------------------------------------------------------------------

const edge = (
  id: string,
  sourceId: string,
  targetId: string,
  kind: MemoryGraphEdge["kind"]
): MemoryGraphEdge => ({ id, sourceId, targetId, kind })

const memoryGraphEdges: ReadonlyArray<MemoryGraphEdge> = [
  edge("edge-1", "page-billing-overview", "page-billing-invoices", "wikilink"),
  edge("edge-2", "page-billing-overview", "page-billing-dunning", "wikilink"),
  edge("edge-3", "page-billing-invoices", "schema-invoice", "schema"),
  edge("edge-4", "page-billing-invoices", "source-stripe", "citation"),
  edge("edge-5", "page-billing-dunning", "source-stripe", "citation"),
  edge("edge-6", "page-billing-overview", "page-billing-taxes", "wikilink"),
  edge("edge-7", "page-infra-deploy", "page-infra-observability", "wikilink"),
  edge("edge-8", "page-infra-deploy", "source-terraform", "dependency"),
  edge("edge-9", "page-infra-deploy", "page-infra-secrets", "wikilink"),
  edge("edge-10", "page-infra-observability", "page-infra-incident", "wikilink"),
  edge("edge-11", "page-infra-secrets", "source-terraform", "dependency"),
  edge("edge-12", "page-auth-overview", "page-auth-oauth", "wikilink"),
  edge("edge-13", "page-auth-overview", "page-auth-sessions", "wikilink"),
  edge("edge-14", "page-auth-sessions", "schema-session", "schema"),
  edge("edge-15", "page-auth-oauth", "source-betterauth", "citation"),
  edge("edge-16", "page-auth-overview", "source-betterauth", "citation"),
  edge("edge-17", "page-auth-sessions", "page-auth-overview", "backlink"),
  edge("edge-18", "page-onboarding-flow", "page-onboarding-invites", "wikilink"),
  edge("edge-19", "page-onboarding-flow", "page-auth-overview", "dependency"),
  edge("edge-20", "page-onboarding-invites", "page-onboarding-checklist", "wikilink"),
  edge("edge-21", "page-billing-overview", "page-infra-deploy", "dependency"),
  edge("edge-22", "page-onboarding-flow", "page-billing-overview", "wikilink")
]

/** A populated bounded graph across four topic clusters. */
export const memoryGraphView: MemoryGraphView = {
  version: 1,
  totalNodes: memoryGraphNodes.length,
  totalEdges: memoryGraphEdges.length,
  nodes: memoryGraphNodes,
  edges: memoryGraphEdges,
  clusters: [
    { id: TOPIC_BILLING, label: "Billing & payments", nodeCount: 6, sampleNodeIds: ["page-billing-overview", "page-billing-invoices", "page-billing-dunning"] },
    { id: TOPIC_INFRA, label: "Infrastructure", nodeCount: 5, sampleNodeIds: ["page-infra-deploy", "page-infra-observability", "page-infra-secrets"] },
    { id: TOPIC_AUTH, label: "Authentication", nodeCount: 5, sampleNodeIds: ["page-auth-overview", "page-auth-oauth", "page-auth-sessions"] },
    { id: TOPIC_ONBOARDING, label: "Onboarding", nodeCount: 3, sampleNodeIds: ["page-onboarding-flow", "page-onboarding-invites", "page-onboarding-checklist"] }
  ],
  truncated: false
}

/**
 * A large, deliberately truncated vault — the real totals dwarf the returned
 * slice, so the map's "N/total nodes · bounded" readout has something to show.
 */
export const memoryGraphViewLarge: MemoryGraphView = {
  ...memoryGraphView,
  totalNodes: 1284,
  totalEdges: 5310,
  truncated: true,
  nextCursor: "cursor-page-2"
}

// ---------------------------------------------------------------------------
// Precomputed layout (map positions)
// ---------------------------------------------------------------------------

/** A cluster-grouped layout in the map's local coordinate space. */
export const memoryNodePositions: ReadonlyArray<MemoryNodePosition> = [
  // Billing (top-left)
  { id: "page-billing-overview", x: -260, y: -160 },
  { id: "page-billing-invoices", x: -360, y: -90 },
  { id: "page-billing-dunning", x: -180, y: -80 },
  { id: "source-stripe", x: -420, y: -180 },
  { id: "schema-invoice", x: -330, y: -230 },
  { id: "page-billing-taxes", x: -200, y: -240 },
  // Infrastructure (top-right)
  { id: "page-infra-deploy", x: 260, y: -160 },
  { id: "page-infra-observability", x: 360, y: -100 },
  { id: "page-infra-incident", x: 420, y: -180 },
  { id: "source-terraform", x: 180, y: -90 },
  { id: "page-infra-secrets", x: 300, y: -250 },
  // Authentication (bottom-left)
  { id: "page-auth-overview", x: -260, y: 160 },
  { id: "page-auth-oauth", x: -360, y: 220 },
  { id: "page-auth-sessions", x: -180, y: 230 },
  { id: "schema-session", x: -140, y: 150 },
  { id: "source-betterauth", x: -360, y: 110 },
  // Onboarding (bottom-right)
  { id: "page-onboarding-flow", x: 260, y: 160 },
  { id: "page-onboarding-invites", x: 360, y: 210 },
  { id: "page-onboarding-checklist", x: 400, y: 120 },
  // Orphan island (top-center)
  { id: "page-orphan-legacy", x: 0, y: -330 }
]

/** Default map filter state: everything visible, including isolated nodes. */
export const memoryDefaultFilters: MemoryMapFilters = {
  query: "",
  topic: null,
  relationship: null,
  freshness: null,
  healthOnly: false,
  showIsolated: true
}

/** A fitted viewport that frames the whole layout at a legible zoom. */
export const memoryDefaultViewport: MemoryViewport = { x: 0, y: 0, zoom: 0.85 }

/** Look a node up by id — handy for wiring inspector stories to the graph. */
export const memoryNodeById = (id: string): MemoryGraphNode | null =>
  memoryGraphNodes.find((candidate) => candidate.id === id) ?? null

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

const dailyGrowth: MemoryDashboardSummary["growth"]["daily"] = [
  { day: "2026-07-18", pages: 4, revisions: 11 },
  { day: "2026-07-19", pages: 2, revisions: 6 },
  { day: "2026-07-20", pages: 1, revisions: 3 },
  { day: "2026-07-21", pages: 6, revisions: 14 },
  { day: "2026-07-22", pages: 5, revisions: 12 },
  { day: "2026-07-23", pages: 3, revisions: 9 },
  { day: "2026-07-24", pages: 7, revisions: 18 },
  { day: "2026-07-25", pages: 4, revisions: 10 },
  { day: "2026-07-26", pages: 2, revisions: 5 },
  { day: "2026-07-27", pages: 1, revisions: 2 },
  { day: "2026-07-28", pages: 8, revisions: 21 },
  { day: "2026-07-29", pages: 6, revisions: 16 },
  { day: "2026-07-30", pages: 5, revisions: 13 },
  { day: "2026-07-31", pages: 4, revisions: 12 }
]

/** A healthy, well-populated org summary. */
export const memoryDashboardSummary: MemoryDashboardSummary = {
  version: 1,
  asOf: "2026-07-31T12:00:00.000Z",
  growth: {
    acceptedPages: 342,
    revisions: 1287,
    sources: 96,
    daily: dailyGrowth
  },
  citationCoverage: {
    citations: 512,
    citedPages: 268,
    totalPages: 342,
    ratio: 0.78
  },
  freshness: {
    fresh: 214,
    aging: 88,
    stale: 32,
    unknown: 8
  },
  health: {
    orphanPages: 6,
    brokenLinks: 4,
    contradictions: 2
  },
  connectivity: {
    pages: 342,
    directedLinks: 894,
    connectedPages: 336,
    averageDegree: 5.2
  },
  retrieval: {
    searches: 1840,
    reads: 3120,
    navigation: 640,
    graphReads: 210,
    proposals: 220,
    zeroResultSearches: 92,
    zeroResultRatio: 0.05,
    resultsReturned: 8420,
    uniqueQueryHashes: 512,
    medianDurationMs: 120,
    p95DurationMs: 480
  }
}

/** A much larger vault, for stress-testing the numbers and bar heights. */
export const memoryDashboardSummaryLarge: MemoryDashboardSummary = {
  ...memoryDashboardSummary,
  growth: {
    acceptedPages: 4821,
    revisions: 21640,
    sources: 1130,
    daily: dailyGrowth.map((day) => ({ ...day, pages: day.pages * 9, revisions: day.revisions * 11 }))
  },
  citationCoverage: { citations: 9120, citedPages: 3980, totalPages: 4821, ratio: 0.83 },
  freshness: { fresh: 3120, aging: 1240, stale: 401, unknown: 60 },
  health: { orphanPages: 84, brokenLinks: 61, contradictions: 19 },
  connectivity: { pages: 4821, directedLinks: 18240, connectedPages: 4712, averageDegree: 7.6 },
  retrieval: {
    searches: 41200,
    reads: 88300,
    navigation: 14200,
    graphReads: 6100,
    proposals: 3210,
    zeroResultSearches: 3090,
    zeroResultRatio: 0.075,
    resultsReturned: 214800,
    uniqueQueryHashes: 12840,
    medianDurationMs: 180,
    p95DurationMs: 640
  }
}

/**
 * A young vault with sparse activity and no latency samples yet.
 */
export const memoryDashboardSummaryNascent: MemoryDashboardSummary = {
  ...memoryDashboardSummary,
  growth: {
    acceptedPages: 12,
    revisions: 21,
    sources: 4,
    daily: dailyGrowth.slice(-7).map((day) => ({ ...day, pages: 1, revisions: 2 }))
  },
  citationCoverage: { citations: 8, citedPages: 5, totalPages: 12, ratio: 0.42 },
  freshness: { fresh: 12, aging: 0, stale: 0, unknown: 0 },
  health: { orphanPages: 1, brokenLinks: 0, contradictions: 0 },
  connectivity: { pages: 12, directedLinks: 9, connectedPages: 7, averageDegree: 1.5 },
  retrieval: {
    searches: 24,
    reads: 40,
    navigation: 6,
    graphReads: 2,
    proposals: 3,
    zeroResultSearches: 9,
    zeroResultRatio: 0.375,
    resultsReturned: 61,
    uniqueQueryHashes: 18,
    medianDurationMs: null,
    p95DurationMs: null
  }
}

// ---------------------------------------------------------------------------
// Page details (inspector + browser)
// ---------------------------------------------------------------------------

const billingOverviewDetail: MemoryPageDetail = {
  page: {
    id: "page-billing-overview",
    path: "billing/overview.md",
    title: "Billing overview",
    revision: 7,
    aliases: ["billing", "payments-overview"],
    tags: ["billing", "payments", "stripe", "revenue"],
    body: `# Billing overview

Billing runs entirely through Stripe. Every customer maps to exactly one Stripe
Customer, and every paid plan to a Stripe Subscription. We never store card
data ourselves — the client tokenizes via Stripe Elements and we keep only the
opaque payment-method id.

## Invoicing

Invoices are generated by [[Invoice generation]] on the monthly anniversary of
the subscription's start date. See the [[Tax handling]] page for how VAT and
US sales tax are applied per-line before the invoice is finalized.

## Failed payments

When a charge fails, [[Dunning & retries]] takes over: three Smart Retries over
a week, then a downgrade to the free plan. Dunning emails are transactional and
bypass marketing consent.

## Reconciliation

A nightly job reconciles Stripe's balance transactions against our ledger. Any
drift above one cent pages the on-call finance engineer.`,
    citations: [
      { id: "cite-stripe-subs", sourceId: "source-stripe", locator: "§ Subscriptions", quote: "A Subscription ties a Customer to a recurring Price." },
      { id: "cite-stripe-retries", sourceId: "source-stripe", locator: "§ Smart Retries" },
      { id: "cite-invoice-schema", sourceId: "schema-invoice", locator: "invoice.line_items" }
    ]
  },
  revision: {
    id: "rev-billing-overview-7",
    pageId: "page-billing-overview",
    revision: 7,
    authorId: "user-amara",
    createdAt: "2026-07-28T09:12:00.000Z",
    acceptedAt: "2026-07-28T14:40:00.000Z"
  },
  sourceIds: ["source-stripe", "schema-invoice"],
  citationIds: ["cite-stripe-subs", "cite-stripe-retries", "cite-invoice-schema"],
  backlinks: ["page-onboarding-flow", "page-billing-invoices", "page-billing-dunning"],
  contributors: ["Amara Okafor", "Diego Santos", "Priya Nair"],
  health: { brokenLinks: 0, contradictions: 0, orphan: false }
}

const authOverviewDetail: MemoryPageDetail = {
  page: {
    id: "page-auth-overview",
    path: "auth/architecture.md",
    title: "Auth architecture",
    revision: 11,
    aliases: ["auth", "identity"],
    tags: ["auth", "security", "betterauth", "oauth", "sessions"],
    body: `# Auth architecture

Authentication is handled by BetterAuth on the Hono server. It issues an opaque
bearer token that the desktop app stores encrypted at rest. There is no JWT on
our side — the token is a random handle, and every request round-trips to the
session store.

## Providers

We support GitHub and Google OAuth plus email magic links. See
[[OAuth providers]] for the redirect URIs and scopes, and [[Session lifecycle]]
for how tokens are minted, refreshed, and revoked.

## Sessions

A session references the [[Session schema]] row. Idle sessions expire after 30
days; explicit sign-out revokes immediately. NOTE: the sessions page currently
disagrees with this on the idle window — see the open contradiction finding.`,
    citations: [
      { id: "cite-ba-bearer", sourceId: "source-betterauth", locator: "§ Bearer plugin", quote: "The bearer plugin returns an opaque token, not a JWT." },
      { id: "cite-ba-oauth", sourceId: "source-betterauth", locator: "§ Social providers" }
    ]
  },
  revision: {
    id: "rev-auth-overview-11",
    pageId: "page-auth-overview",
    revision: 11,
    authorId: "user-diego",
    createdAt: "2026-07-30T16:02:00.000Z",
    acceptedAt: "2026-07-30T18:20:00.000Z"
  },
  sourceIds: ["source-betterauth"],
  citationIds: ["cite-ba-bearer", "cite-ba-oauth"],
  backlinks: ["page-onboarding-flow", "page-auth-oauth", "page-auth-sessions"],
  contributors: ["Diego Santos", "Wei Chen"],
  health: { brokenLinks: 0, contradictions: 1, orphan: false }
}

const infraDeployDetail: MemoryPageDetail = {
  page: {
    id: "page-infra-deploy",
    path: "infra/deployment.md",
    title: "Deployment pipeline",
    revision: 5,
    aliases: ["deploy", "ci-cd"],
    tags: ["infra", "deploy", "terraform", "ci"],
    body: `# Deployment pipeline

Every merge to \`main\` builds a container, runs the full test matrix, and — on
green — applies the [[Secrets management]] rotation before a blue/green cutover.
Infrastructure is declared in Terraform; see the Terraform modules source for
the module graph.

## Rollback

A cutover keeps the previous colour warm for fifteen minutes. Rollback is a DNS
weight flip, not a redeploy, so it completes in under a minute.`,
    citations: [
      { id: "cite-tf-modules", sourceId: "source-terraform", locator: "modules/service" }
    ]
  },
  revision: {
    id: "rev-infra-deploy-5",
    pageId: "page-infra-deploy",
    revision: 5,
    authorId: "user-wei",
    createdAt: "2026-07-22T11:30:00.000Z",
    acceptedAt: "2026-07-22T13:05:00.000Z"
  },
  sourceIds: ["source-terraform"],
  citationIds: ["cite-tf-modules"],
  backlinks: ["page-billing-overview", "page-infra-observability", "page-infra-secrets"],
  contributors: ["Wei Chen", "Amara Okafor"],
  health: { brokenLinks: 0, contradictions: 0, orphan: false }
}

/** Every full page detail, keyed by page id — browser "open page" uses this. */
export const memoryPageDetailsById: Readonly<Record<string, MemoryPageDetail>> = {
  "page-billing-overview": billingOverviewDetail,
  "page-auth-overview": authOverviewDetail,
  "page-infra-deploy": infraDeployDetail
}

/** The default selected page for the inspector and browser reader stories. */
export const memoryPageDetail: MemoryPageDetail = billingOverviewDetail

/** The graph node behind the default selected page. */
export const memoryInspectorNode: MemoryGraphNode =
  memoryNodeById("page-billing-overview") ?? memoryGraphNodes[0]!

// ---------------------------------------------------------------------------
// Edge evidence (inspector, edge-selected state)
// ---------------------------------------------------------------------------

/** Accepted evidence for a citation edge — billing overview → Stripe. */
export const memoryEdgeEvidence: MemoryEdgeEvidence = {
  edge: { id: "edge-4", sourceId: "page-billing-invoices", targetId: "source-stripe", kind: "citation" },
  evidence: {
    kind: "citation",
    sourcePageId: "page-billing-invoices",
    sourceId: "source-stripe",
    citationId: "cite-stripe-retries",
    path: "billing/invoices.md",
    line: 42,
    column: 3,
    raw: "> A Subscription ties a Customer to a recurring Price. [^stripe-subs]",
    label: "Stripe API reference § Subscriptions"
  }
}

// ---------------------------------------------------------------------------
// Search results (browser)
// ---------------------------------------------------------------------------

export const memorySearchResults: ReadonlyArray<MemorySearchResult> = [
  { pageId: "page-billing-overview", path: "billing/overview.md", title: "Billing overview", revisionId: "rev-billing-overview-7", snippet: "Billing runs entirely through Stripe. Every customer maps to exactly one Stripe Customer, and every paid plan to a Subscription." },
  { pageId: "page-billing-invoices", path: "billing/invoices.md", title: "Invoice generation", revisionId: "rev-billing-invoices-4", snippet: "Invoices are generated on the monthly anniversary of the subscription's start date, with tax applied per-line before finalizing." },
  { pageId: "page-billing-dunning", path: "billing/dunning.md", title: "Dunning & retries", revisionId: "rev-billing-dunning-3", snippet: "Failed charges trigger three Smart Retries over a week, then a downgrade to the free plan. Dunning email bypasses marketing consent." },
  { pageId: "page-auth-overview", path: "auth/architecture.md", title: "Auth architecture", revisionId: "rev-auth-overview-11", snippet: "BetterAuth issues an opaque bearer token stored encrypted at rest — no JWT; every request round-trips to the session store." },
  { pageId: "page-infra-deploy", path: "infra/deployment.md", title: "Deployment pipeline", revisionId: "rev-infra-deploy-5", snippet: "Every merge to main builds a container, runs the full test matrix, and on green rotates secrets before a blue/green cutover." },
  { pageId: "page-billing-taxes", path: "billing/taxes.md", title: "Tax handling", revisionId: "rev-billing-taxes-2", snippet: "VAT and US sales tax are computed per-line via Stripe Tax before the invoice is finalized; reverse-charge is applied for EU B2B." }
]

// ---------------------------------------------------------------------------
// Relatedness suggestions (advisory — NOT edges)
// ---------------------------------------------------------------------------

const EMBED_MODEL = "text-embedding-3-large"

/** Advisory relatedness for the billing overview page. */
export const memorySuggestions: ReadonlyArray<MemorySuggestion> = [
  {
    sourceId: "page-billing-overview",
    targetId: "page-auth-overview",
    method: "embedding",
    score: 0.82,
    sourceTitle: "Billing overview",
    targetTitle: "Auth architecture",
    evidence: {
      method: "embedding",
      cosine: 0.82,
      sharedTags: ["security"],
      sharedSources: ["source-betterauth"],
      model: EMBED_MODEL,
      neighborRank: 1
    }
  },
  {
    sourceId: "page-billing-overview",
    targetId: "page-infra-deploy",
    method: "embedding",
    score: 0.74,
    sourceTitle: "Billing overview",
    targetTitle: "Deployment pipeline",
    evidence: {
      method: "embedding",
      cosine: 0.74,
      sharedTags: ["revenue", "ci"],
      model: EMBED_MODEL,
      neighborRank: 2
    }
  },
  {
    sourceId: "page-billing-overview",
    targetId: "page-onboarding-flow",
    method: "lexical",
    score: 0.61,
    sourceTitle: "Billing overview",
    targetTitle: "Onboarding flow",
    evidence: {
      method: "lexical",
      cosine: 0.61,
      sharedTerms: ["plan", "subscription", "customer"],
      sharedTags: ["billing"]
    }
  },
  {
    sourceId: "page-billing-overview",
    targetId: "page-billing-taxes",
    method: "lexical",
    score: 0.58,
    sourceTitle: "Billing overview",
    targetTitle: "Tax handling",
    evidence: {
      method: "lexical",
      cosine: 0.58,
      sharedTerms: ["invoice", "line", "tax", "finalize"],
      sharedSources: ["source-stripe"]
    }
  },
  {
    sourceId: "page-infra-secrets",
    targetId: "page-billing-overview",
    method: "embedding",
    score: 0.53,
    sourceTitle: "Secrets management",
    targetTitle: "Billing overview",
    evidence: {
      method: "embedding",
      cosine: 0.53,
      sharedSchemas: ["schema-invoice"],
      model: EMBED_MODEL,
      neighborRank: 5
    }
  }
]
