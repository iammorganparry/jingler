import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { MemoryDashboardSummary } from "@jingler/contracts"

const MEMORY_PROTOCOL = "2026-07-28"
const DEFAULT_TOKEN = "e2e-token"
const DEFAULT_PAID_ORGANIZATIONS = ["org-e2e", "org-other"] as const
const CREDENTIAL_PATTERN = /\b(?:api[_-]?key|password|secret)\s*[:=]|\bsk-[A-Za-z0-9_-]{8,}/i

type ProposalStatus = "open" | "accepted" | "rejected" | "superseded"

interface FakePage {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly revision: number
  readonly body: string
  readonly aliases: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly citations: ReadonlyArray<{
    readonly id: string
    readonly sourceId: string
    readonly locator?: string
    readonly quote?: string
  }>
  readonly authorId: string
  readonly sourceIds: ReadonlyArray<string>
}

interface FakeProposalPage {
  readonly id: string
  readonly pageId: string
  readonly baseRevisionId: string
  readonly markdown: string
  readonly summary: string
}

interface FakeProposal {
  readonly id: string
  readonly workflowId: string
  readonly sourceId: string
  readonly proposedBy: string
  readonly createdAt: string
  status: ProposalStatus
  readonly changeKind: "factual" | "mechanical"
  readonly pages: ReadonlyArray<FakeProposalPage>
}

interface FakeOrganizationMemory {
  readonly pages: Map<string, FakePage>
  readonly proposals: Array<FakeProposal>
  readonly sourceIds: Set<string>
  secretRejections: number
  readonly reviewDecisions: Array<string>
}

export interface FakeMemoryRequest {
  readonly path: string
  readonly httpMethod: string
  readonly rpcMethod: string | null
  readonly mcpMethod: string | null
  readonly mcpName: string | null
  readonly organizationId: string | null
  readonly protocolVersion: string | null
  readonly metadataProtocolVersion: string | null
  readonly hasCookie: boolean
  readonly hasSessionId: boolean
  readonly requestId: string | null
  readonly assignedInstance: "next-a" | "next-b"
}

export interface FakeMemorySnapshot {
  readonly organizationId: string
  readonly acceptedPageIds: ReadonlyArray<string>
  readonly proposalStatuses: Readonly<Record<string, ProposalStatus>>
  readonly sourceCount: number
  readonly secretRejections: number
  readonly reviewDecisions: ReadonlyArray<string>
}

export interface FakeAuthServerOptions {
  readonly token?: string
  readonly paidOrganizationIds?: ReadonlyArray<string>
  readonly unavailable?: boolean
  readonly acceptedLearningOrganizationIds?: ReadonlyArray<string>
}

/**
 * Offline BetterAuth + stateless Next.js MCP + private-memory fake.
 *
 * The state lives per organization and survives multiple Electron launches that
 * share this server. That makes publication and tenant-isolation assertions
 * full-loop without a real Postgres, Vercel deployment, or Cloudflare account.
 */
export interface FakeAuthServer {
  readonly url: string
  readonly token: string
  readonly sentEmails: ReadonlyArray<string>
  readonly memoryRequests: ReadonlyArray<FakeMemoryRequest>
  readonly memorySnapshot: (organizationId: string) => FakeMemorySnapshot
  readonly setMemoryAvailable: (available: boolean) => void
  readonly close: () => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const jsonBody = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}

const basePages = (organizationId: string): ReadonlyArray<FakePage> => {
  const other = organizationId !== "org-e2e"
  const prefix = other ? "other-" : ""
  const titlePrefix = other ? "Other organization " : ""
  return [
    {
      id: `${prefix}alpha`,
      path: `${prefix}alpha.md`,
      title: `${titlePrefix}Alpha memory`,
      revision: 2,
      body: `# ${titlePrefix}Alpha memory\n\nThe accepted architecture links to [[${prefix}beta]]. [^source-alpha]`,
      aliases: [],
      tags: ["architecture"],
      citations: [{ id: "source-alpha", sourceId: `source:${organizationId}:alpha`, locator: "L1-L8" }],
      authorId: "user:alpha",
      sourceIds: [`source:${organizationId}:alpha`]
    },
    {
      id: `${prefix}beta`,
      path: `${prefix}beta.md`,
      title: `${titlePrefix}Beta memory`,
      revision: 1,
      body: `# ${titlePrefix}Beta memory\n\nThis accepted page is the architecture target. [^source-beta]`,
      aliases: [],
      tags: ["architecture"],
      citations: [{ id: "source-beta", sourceId: `source:${organizationId}:beta`, locator: "L1-L4" }],
      authorId: "user:beta",
      sourceIds: [`source:${organizationId}:beta`]
    }
  ]
}

const fixedProposals = (): Array<FakeProposal> => [
  {
    id: "proposal:stale",
    workflowId: "compiler-stale",
    sourceId: "source:stale",
    proposedBy: "agent:stale",
    createdAt: "2026-08-01T08:00:00.000Z",
    status: "open",
    changeKind: "factual",
    pages: [{
      id: "proposal-page:stale",
      pageId: "alpha",
      baseRevisionId: "revision:alpha:1",
      summary: "An intentionally stale edit used to verify conflict handling.",
      markdown: "---\nid: alpha\ntitle: Alpha memory\nrevision: 3\n---\n\nStale overwrite attempt. [^stale]\n"
    }]
  },
  {
    id: "proposal:secret",
    workflowId: "compiler-secret",
    sourceId: "source:secret",
    proposedBy: "agent:secret",
    createdAt: "2026-08-01T09:00:00.000Z",
    status: "open",
    changeKind: "factual",
    pages: [{
      id: "proposal-page:secret",
      pageId: "secret-page",
      baseRevisionId: "revision:secret-page:0",
      summary: "Credential-shaped content must fail lint before publication.",
      markdown: "---\nid: secret-page\ntitle: Secret-shaped proposal\nrevision: 1\n---\n\napi_key=sk-test-never-publish [^secret]\n"
    }]
  }
]

const acceptedLearningPages = (sourceId: string): ReadonlyArray<FakePage> => [
  {
    id: "shared-learning",
    path: "engineering/refund-rate-limiting.md",
    title: "Refund rate limiting",
    revision: 1,
    body: "# Refund rate limiting\n\nReuse the token bucket for POST /refund and verify the 429 path. [[shared-checklist]] [^session]",
    aliases: ["refund limiter"],
    tags: ["backend", "reliability"],
    citations: [{ id: "session", sourceId, locator: "settled agent session" }],
    authorId: "reviewer:e2e",
    sourceIds: [sourceId]
  },
  {
    id: "shared-checklist",
    path: "engineering/refund-rate-limit-checklist.md",
    title: "Refund rate-limit checklist",
    revision: 1,
    body: "# Refund rate-limit checklist\n\nExercise the accepted route and its 429 response. [^session]",
    aliases: [],
    tags: ["backend", "testing"],
    citations: [{ id: "session", sourceId, locator: "settled agent session" }],
    authorId: "reviewer:e2e",
    sourceIds: [sourceId]
  }
]

const capturedProposal = (sourceId: string): FakeProposal => ({
  id: "proposal:captured-learning",
  workflowId: "compiler-captured-learning",
  sourceId,
  proposedBy: "agent:session-capture",
  createdAt: "2026-08-01T12:00:00.000Z",
  status: "open",
  changeKind: "factual",
  pages: [
    {
      id: "proposal-page:shared-learning",
      pageId: "shared-learning",
      baseRevisionId: "revision:shared-learning:0",
      summary: "Publish the cited rate-limiting learning from the settled session.",
      markdown: "---\nid: shared-learning\ntitle: Refund rate limiting\nrevision: 1\n---\n\nReuse the token bucket for POST /refund. [[shared-checklist]] [^session]\n"
    },
    {
      id: "proposal-page:shared-checklist",
      pageId: "shared-checklist",
      baseRevisionId: "revision:shared-checklist:0",
      summary: "Add the companion verification checklist in the same publication.",
      markdown: "---\nid: shared-checklist\ntitle: Refund rate-limit checklist\nrevision: 1\n---\n\nVerify the accepted route and its 429 response. [^session]\n"
    }
  ]
})

const pageResponse = (page: FakePage) => ({
  page: {
    id: page.id,
    path: page.path,
    title: page.title,
    revision: page.revision,
    aliases: page.aliases,
    tags: page.tags,
    body: page.body,
    citations: page.citations
  },
  revision: {
    id: `revision:${page.id}:${page.revision}`,
    pageId: page.id,
    revision: page.revision,
    authorId: page.authorId,
    createdAt: "2026-08-01T00:00:00.000Z",
    acceptedAt: "2026-08-01T00:10:00.000Z"
  },
  sourceIds: page.sourceIds,
  citationIds: page.citations.map((citation) => citation.id)
})

const graphFor = (organizationId: string, state: FakeOrganizationMemory) => {
  const pages = [...state.pages.values()].sort((left, right) => left.id.localeCompare(right.id))
  const alphaId = organizationId === "org-e2e" ? "alpha" : "other-alpha"
  const betaId = organizationId === "org-e2e" ? "beta" : "other-beta"
  const edges: Array<{ id: string; sourceId: string; targetId: string; kind: "wikilink" | "dependency" }> = [
    { id: `edge:${organizationId}:alpha-beta`, sourceId: `page:${alphaId}`, targetId: `page:${betaId}`, kind: "wikilink" }
  ]
  if (state.pages.has("shared-learning")) {
    edges.push(
      { id: "edge:e2e:alpha-shared", sourceId: "page:alpha", targetId: "page:shared-learning", kind: "wikilink" },
      { id: "edge:e2e:shared-checklist", sourceId: "page:shared-learning", targetId: "page:shared-checklist", kind: "dependency" }
    )
  }
  const nodes = pages.map((page, index) => ({
    id: `page:${page.id}`,
    kind: "page",
    title: page.title,
    pageId: page.id,
    topicId: page.id.startsWith("shared-") ? "topic:reliability" : "topic:architecture",
    degree: {
      incoming: edges.filter((edge) => edge.targetId === `page:${page.id}`).length,
      outgoing: edges.filter((edge) => edge.sourceId === `page:${page.id}`).length
    },
    freshness: index % 2 === 0 ? "fresh" : "stale",
    health: {
      brokenLinks: page.id === alphaId ? 1 : 0,
      contradictions: 0,
      orphan: !edges.some((edge) => edge.sourceId === `page:${page.id}` || edge.targetId === `page:${page.id}`)
    }
  }))
  const added = Math.max(0, pages.length - 2)
  return {
    version: 1,
    totalNodes: 10_000 + added,
    totalEdges: 22_000 + Math.max(0, edges.length - 1),
    nodes,
    edges,
    clusters: [
      { id: "topic:architecture", label: "Architecture", nodeCount: 9_800, sampleNodeIds: [`page:${alphaId}`] },
      ...(state.pages.has("shared-learning")
        ? [{ id: "topic:reliability", label: "Reliability", nodeCount: 202, sampleNodeIds: ["page:shared-learning"] }]
        : [])
    ],
    truncated: true,
    nextCursor: String(nodes.length)
  }
}

/**
 * Time-scoped fields shrink with a shorter window, exactly as the worker's
 * `windowAnalyticsInput` clamps the retrieval and daily-growth series to
 * `[asOf - range, asOf]`. Current-state inputs (accepted pages, sources,
 * freshness, health, connectivity) are a snapshot and are NEVER windowed — the
 * dashboard drilldown spec relies on that split, asserting `Searches` moves
 * with the selector while `Accepted pages` (10000) does not.
 */
const RANGE_SEARCHES: Readonly<Record<string, number>> = {
  "7d": 9,
  "30d": 32,
  "90d": 63,
  all: 90
}
const rangeScale = (range: string): number => RANGE_SEARCHES[range] ?? RANGE_SEARCHES.all!

const dashboardFor = (state: FakeOrganizationMemory, range = "all"): MemoryDashboardSummary => {
  const added = Math.max(0, state.pages.size - 2)
  const open = state.proposals.filter((proposal) => proposal.status === "open").length
  const accepted = state.proposals.filter((proposal) => proposal.status === "accepted").length
  // Derive every windowed retrieval count from the same per-range anchor so the
  // whole block moves together, the way a real time-scoped aggregation would.
  const searches = rangeScale(range)
  return {
    version: 1,
    asOf: "2026-08-01T00:00:00.000Z",
    growth: { acceptedPages: 10_000 + added, revisions: 12_400 + added, sources: 3_100 + state.sourceIds.size, daily: [{ day: "2026-08-01", pages: 12 + added, revisions: 30 + added }] },
    citationCoverage: { citations: 15_000 + added, citedPages: 9_200 + added, totalPages: 10_000 + added, ratio: 0.92 },
    freshness: { fresh: 8_000 + added, aging: 1_200, stale: 800, unknown: 0 },
    health: { orphanPages: 20, brokenLinks: 4, contradictions: 2 },
    reviewThroughput: { proposed: 40 + state.proposals.length, accepted: 30 + accepted, rejected: 5, conflicted: state.secretRejections + 1, open, acceptanceRatio: 0.8333, medianReviewHours: 3.5 },
    connectivity: { pages: 10_000 + added, directedLinks: 22_000 + added, connectedPages: 9_980 + added, averageDegree: 4.4 },
    retrieval: {
      searches,
      reads: Math.round(searches * 0.6),
      navigation: Math.round(searches * 0.23),
      graphReads: Math.round(searches * 0.19),
      proposals: Math.round(searches * 0.07),
      zeroResultSearches: 2,
      zeroResultRatio: 0.0222,
      resultsReturned: searches * 6,
      uniqueQueryHashes: Math.round(searches * 0.9),
      medianDurationMs: 8,
      p95DurationMs: 21
    }
  }
}

/**
 * Advisory relatedness suggestions in the worker's `MemorySuggestionsView` wire
 * shape (see `MemoryBackendSuggestions` in the desktop main). DELIBERATELY not a
 * graph edge: every pair returned here is one the accepted graph does NOT join,
 * so the inspector's "related pages" panel can only ever be advisory. The fake
 * stays lexical-only (no turbopuffer), matching a deployment with no vector key.
 */
const suggestionsFor = (organizationId: string, state: FakeOrganizationMemory) => {
  const has = (id: string): boolean => state.pages.has(id)
  const suggestions: Array<{
    sourceId: string
    targetId: string
    method: "lexical" | "embedding"
    score: number
    evidence: {
      method: "lexical" | "embedding"
      cosine: number
      sharedTerms?: ReadonlyArray<string>
      sharedTags?: ReadonlyArray<string>
      sharedSources?: ReadonlyArray<string>
    }
  }> = []
  // The learning scenario adds shared-learning/shared-checklist. alpha and
  // shared-checklist are NOT joined by any accepted edge (alpha→beta,
  // alpha→shared-learning, shared-learning→shared-checklist are), so this pair
  // proves a suggestion is distinct from an accepted relationship.
  if (organizationId === "org-e2e" && has("alpha") && has("shared-checklist")) {
    suggestions.push({
      sourceId: "alpha",
      targetId: "shared-checklist",
      method: "lexical",
      score: 0.41,
      evidence: {
        method: "lexical",
        cosine: 0.37,
        sharedTerms: ["architecture", "accepted", "route"],
        sharedTags: ["backend"],
        sharedSources: []
      }
    })
  }
  return { version: 1 as const, vectorSource: "lexical" as const, suggestions }
}

const normalizeOptions = (value: string | FakeAuthServerOptions): Required<Omit<FakeAuthServerOptions, "acceptedLearningOrganizationIds">> & { readonly acceptedLearningOrganizationIds: ReadonlyArray<string> } =>
  typeof value === "string"
    ? { token: value, paidOrganizationIds: DEFAULT_PAID_ORGANIZATIONS, unavailable: false, acceptedLearningOrganizationIds: [] }
    : {
        token: value.token ?? DEFAULT_TOKEN,
        paidOrganizationIds: value.paidOrganizationIds ?? DEFAULT_PAID_ORGANIZATIONS,
        unavailable: value.unavailable ?? false,
        acceptedLearningOrganizationIds: value.acceptedLearningOrganizationIds ?? []
      }

export const startFakeAuthServer = async (
  input: string | FakeAuthServerOptions = {}
): Promise<FakeAuthServer> => {
  const options = normalizeOptions(input)
  const sentEmails: Array<string> = []
  const requests: Array<FakeMemoryRequest> = []
  const organizations = new Map<string, FakeOrganizationMemory>()
  let memoryAvailable = !options.unavailable
  let requestSequence = 0

  const stateFor = (organizationId: string): FakeOrganizationMemory => {
    const existing = organizations.get(organizationId)
    if (existing !== undefined) return existing
    const state: FakeOrganizationMemory = {
      pages: new Map(basePages(organizationId).map((page) => [page.id, page])),
      proposals: organizationId === "org-e2e" ? fixedProposals() : [],
      sourceIds: new Set(),
      secretRejections: 0,
      reviewDecisions: []
    }
    if (options.acceptedLearningOrganizationIds.includes(organizationId)) {
      const sourceId = "session-digest:seeded-learning"
      state.sourceIds.add(sourceId)
      for (const page of acceptedLearningPages(sourceId)) state.pages.set(page.id, page)
    }
    organizations.set(organizationId, state)
    return state
  }

  const grantFor = (organizationId: string): string => `e2e-memory-grant:${organizationId}`
  const organizationFromGrant = (authorization: string | undefined): string | null => {
    const prefix = "Bearer e2e-memory-grant:"
    return authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : null
  }

  const server: Server = createServer((req, res) => {
    const host = req.headers.host ?? "localhost"
    const url = new URL(req.url ?? "/", `http://${host}`)
    const json = (code: number, body: unknown, headers: Readonly<Record<string, string>> = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers })
      res.end(JSON.stringify(body))
    }
    const readJson = (): Promise<unknown> =>
      new Promise((resolve) => {
        let body = ""
        req.on("data", (chunk) => (body += chunk))
        req.on("end", () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve(null)
          }
        })
      })

    if (url.pathname === "/api/memory/organizations" && req.method === "GET") {
      if (!memoryAvailable) return json(503, { error: "memory unavailable" })
      if (req.headers.authorization !== `Bearer ${options.token}`) return json(401, {})
      return json(200, {
        organizations: options.paidOrganizationIds.map((id) => ({
          id,
          name: id === "org-e2e" ? "Jingler Team" : "Other Team",
          role: "owner",
          privileges: ["read", "propose", "review", "schema"]
        }))
      })
    }

    if (url.pathname === "/api/memory/grant" && req.method === "POST") {
      if (!memoryAvailable) return json(503, { error: "memory unavailable" })
      if (req.headers.authorization !== `Bearer ${options.token}`) return json(401, {})
      readJson().then((value) => {
        const body = jsonBody(value)
        const organizationId = typeof body.organizationId === "string" ? body.organizationId : ""
        if (!options.paidOrganizationIds.includes(organizationId)) return json(403, { error: "active paid membership required" })
        stateFor(organizationId)
        return json(200, {
          grant: grantFor(organizationId),
          claims: {
            version: 1,
            issuer: "jingler",
            audience: "jingler-memory",
            subject: "u_e2e",
            organizationId,
            privileges: ["read", "propose", "review", "schema"],
            issuedAt: 1_700_000_000,
            expiresAt: 4_102_444_800,
            grantId: `grant-e2e-${organizationId}`
          }
        })
      })
      return
    }

    if (url.pathname === "/api/memory/sources" && req.method === "POST") {
      if (!memoryAvailable) return json(503, { error: "memory unavailable" })
      const organizationId = req.headers["x-jingler-organization-id"]
      const grantOrganization = organizationFromGrant(req.headers.authorization)
      if (typeof organizationId !== "string" || grantOrganization !== organizationId) return json(401, {})
      readJson().then((value) => {
        const body = jsonBody(value)
        const source = jsonBody(body.source)
        const sourceId = typeof source.id === "string" ? source.id : ""
        const content = typeof body.content === "string" ? body.content : ""
        if (sourceId.length === 0 || req.headers["x-idempotency-key"] !== sourceId) return json(400, { error: "invalid digest" })
        const state = stateFor(organizationId)
        if (CREDENTIAL_PATTERN.test(content)) {
          state.secretRejections += 1
          state.reviewDecisions.push(`source:${sourceId}:secret-rejected`)
          return json(422, { error: "credential-shaped content rejected" })
        }
        if (!state.sourceIds.has(sourceId)) {
          state.sourceIds.add(sourceId)
          if (!state.proposals.some((proposal) => proposal.id === "proposal:captured-learning")) {
            state.proposals.push(capturedProposal(sourceId))
          }
        }
        return json(201, {
          source: { ...source, id: sourceId },
          contentHash: "sha256:e2e-captured",
          contentKey: `organizations/${organizationId}/sources/blobs/e2e-captured`,
          workflowId: "compiler-captured-learning"
        })
      })
      return
    }

    if (url.pathname === "/api/mcp" && req.method === "POST") {
      if (!memoryAvailable) return json(503, { error: "memory unavailable" })
      readJson().then((value) => {
        const body = jsonBody(value)
        const params = jsonBody(body.params)
        const metadata = jsonBody(params._meta)
        const organizationId = typeof req.headers["x-jingler-organization-id"] === "string"
          ? req.headers["x-jingler-organization-id"]
          : null
        const assignedInstance = requestSequence % 2 === 0 ? "next-a" : "next-b"
        requestSequence += 1
        const rpcMethod = typeof body.method === "string" ? body.method : null
        const mcpMethod = typeof req.headers["mcp-method"] === "string" ? req.headers["mcp-method"] : null
        const mcpName = typeof req.headers["mcp-name"] === "string" ? req.headers["mcp-name"] : null
        requests.push({
          path: url.pathname,
          httpMethod: req.method ?? "",
          rpcMethod,
          mcpMethod,
          mcpName,
          organizationId,
          protocolVersion: typeof req.headers["mcp-protocol-version"] === "string" ? req.headers["mcp-protocol-version"] : null,
          metadataProtocolVersion: typeof metadata["io.modelcontextprotocol/protocolVersion"] === "string" ? metadata["io.modelcontextprotocol/protocolVersion"] : null,
          hasCookie: req.headers.cookie !== undefined,
          hasSessionId: req.headers["mcp-session-id"] !== undefined,
          requestId: typeof body.id === "string" ? body.id : null,
          assignedInstance
        })

        if (
          organizationId === null ||
          organizationFromGrant(req.headers.authorization) !== organizationId ||
          req.headers["mcp-protocol-version"] !== MEMORY_PROTOCOL ||
          mcpMethod !== rpcMethod ||
          req.headers["mcp-session-id"] !== undefined
        ) {
          return json(401, { error: "invalid stateless MCP request" }, { "x-fake-next-instance": assignedInstance })
        }
        if (rpcMethod === "initialize") return json(400, { error: "initialize is unsupported" })
        if (rpcMethod === "server/discover") {
          return json(200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              resultType: "complete",
              protocolVersion: MEMORY_PROTOCOL,
              serverInfo: { name: "jingler-team-memory", version: "1.0.0" },
              capabilities: { tools: { listChanged: false } }
            }
          }, { "x-fake-next-instance": assignedInstance })
        }
        if (rpcMethod !== "tools/call" || typeof params.name !== "string" || params.name !== mcpName) {
          return json(400, { error: "tool call headers do not match body" }, { "x-fake-next-instance": assignedInstance })
        }
        const state = stateFor(organizationId)
        const args = jsonBody(params.arguments)
        const graph = graphFor(organizationId, state)
        let data: unknown
        switch (params.name) {
          case "memory_dashboard":
            data = dashboardFor(state, typeof args.range === "string" ? args.range : "all")
            break
          case "memory_suggestions":
            data = suggestionsFor(organizationId, state)
            break
          case "memory_graph":
          case "memory_graph_neighborhood":
            data = graph
            break
          case "memory_reviews":
            data = { reviews: state.proposals }
            break
          case "memory_navigation":
            data = {
              indexMarkdown: `# Index\n${[...state.pages.values()].map((page) => `- [[${page.id}|${page.title}]]`).join("\n")}\n`,
              logMarkdown: "# Log\n"
            }
            break
          case "memory_search": {
            const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : ""
            const results = [...state.pages.values()]
              .filter((page) => query.length > 0 && `${page.title} ${page.body} ${page.aliases.join(" ")}`.toLocaleLowerCase().includes(query))
              .map((page) => ({ pageId: page.id, revision: page.revision, path: page.path, title: page.title, snippet: page.body.slice(0, 180) }))
            data = { query, results, total: results.length }
            break
          }
          case "memory_read": {
            const page = typeof args.pageId === "string" ? state.pages.get(args.pageId) : undefined
            data = page === undefined ? {} : pageResponse(page)
            break
          }
          case "memory_edge_evidence": {
            const edgeId = typeof args.edgeId === "string" ? args.edgeId : ""
            const edge = graph.edges.find((candidate) => candidate.id === edgeId) ?? graph.edges[0]
            const shared = edge?.id === "edge:e2e:alpha-shared"
            data = edge === undefined ? {} : {
              edge,
              evidence: {
                kind: edge.kind,
                pageId: shared ? "alpha" : organizationId === "org-e2e" ? "alpha" : "other-alpha",
                path: shared ? "alpha.md" : organizationId === "org-e2e" ? "alpha.md" : "other-alpha.md",
                line: 4,
                column: 1,
                raw: shared ? "[[shared-learning]]" : organizationId === "org-e2e" ? "[[beta]]" : "[[other-beta]]"
              }
            }
            break
          }
          case "memory_review": {
            const proposalId = typeof args.proposalId === "string" ? args.proposalId : ""
            const action = args.action === "approve" ? "approve" : "reject"
            const proposal = state.proposals.find((candidate) => candidate.id === proposalId)
            if (proposal === undefined) {
              data = { status: "conflict", conflicts: [{ pageId: "missing", expectedBaseRevisionId: "proposal", currentHeadRevisionId: "not-found" }] }
              break
            }
            if (proposalId === "proposal:stale" && action === "approve") {
              state.reviewDecisions.push("proposal:stale:conflict")
              data = { status: "conflict", conflicts: [{ pageId: "alpha", expectedBaseRevisionId: "revision:alpha:1", currentHeadRevisionId: "revision:alpha:2" }] }
              break
            }
            if (proposalId === "proposal:secret" && action === "approve") {
              state.secretRejections += 1
              state.reviewDecisions.push("proposal:secret:secret-rejected")
              data = { status: "conflict", conflicts: [{ pageId: "secret-page", expectedBaseRevisionId: "lint:clean", currentHeadRevisionId: "lint:credential-shaped-content" }] }
              break
            }
            proposal.status = action === "approve" ? "accepted" : "rejected"
            state.reviewDecisions.push(`${proposalId}:${proposal.status}`)
            if (proposalId === "proposal:captured-learning" && proposal.status === "accepted") {
              for (const page of acceptedLearningPages(proposal.sourceId)) state.pages.set(page.id, page)
            }
            data = { status: proposal.status, conflicts: [] }
            break
          }
          default:
            data = {}
        }
        return json(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            server: { name: "jingler-team-memory", version: "1.0.0" },
            structuredContent: { data },
            content: []
          }
        }, { "cache-control": "private, max-age=30", "x-fake-next-instance": assignedInstance })
      })
      return
    }

    if (url.pathname === "/api/mcp") return json(405, { error: "POST required" })

    if (url.pathname === "/api/auth/get-session") {
      if (req.headers.authorization === `Bearer ${options.token}`) {
        return json(200, {
          session: { expiresAt: "2099-01-01T00:00:00Z", token: options.token },
          user: { id: "u_e2e", email: "e2e@jingler.dev", name: "E2E User", image: null }
        })
      }
      return json(401, {})
    }

    if (url.pathname === "/api/auth/sign-in/social" && req.method === "POST") {
      return json(200, { url: `http://${host}/desktop/callback?token=${options.token}`, redirect: true })
    }
    if (url.pathname === "/desktop/callback") {
      res.writeHead(302, { Location: `jingler://auth/callback?token=${options.token}` })
      return res.end()
    }
    if (url.pathname === "/api/auth/sign-in/magic-link" && req.method === "POST") {
      readJson().then((value) => {
        const email = jsonBody(value).email
        if (typeof email === "string" && email.includes("fail")) return json(400, { error: "rejected" })
        if (typeof email === "string") sentEmails.push(email)
        return json(200, { status: true })
      })
      return
    }
    if (url.pathname === "/api/auth/sign-out" && req.method === "POST") return json(200, {})
    return json(404, {})
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    token: options.token,
    get sentEmails() {
      return sentEmails
    },
    get memoryRequests() {
      return requests
    },
    memorySnapshot: (organizationId) => {
      const state = stateFor(organizationId)
      return {
        organizationId,
        acceptedPageIds: [...state.pages.keys()].sort(),
        proposalStatuses: Object.fromEntries(state.proposals.map((proposal) => [proposal.id, proposal.status])),
        sourceCount: state.sourceIds.size,
        secretRejections: state.secretRejections,
        reviewDecisions: [...state.reviewDecisions]
      }
    },
    setMemoryAvailable: (available) => {
      memoryAvailable = available
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
