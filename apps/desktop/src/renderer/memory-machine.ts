import type {
  MemoryAccess,
  MemoryDashboardSummary,
  MemoryEdgeEvidence,
  MemoryExport,
  MemoryGraphView,
  MemoryPageDetail,
  MemoryReviewItem,
  MemoryReviewResult,
  MemorySearchResult
} from "@jingler/contracts"
import type {
  MemoryDeepLink,
  MemoryMapFilters,
  MemorySubview,
  MemoryViewport
} from "@jingler/ui"
import { assign, fromPromise, setup } from "xstate"

const LAST_VIEW_KEY = "jingler.memory.last-view"

export interface MemoryApi {
  access(): Promise<MemoryAccess>
  dashboard(organizationId: string, range: string): Promise<MemoryDashboardSummary>
  graph(organizationId: string, limit: number): Promise<MemoryGraphView>
  neighborhood(organizationId: string, nodeId: string, limit: number): Promise<MemoryGraphView>
  evidence(organizationId: string, edgeId: string): Promise<MemoryEdgeEvidence>
  search(organizationId: string, query: string, limit: number): Promise<ReadonlyArray<MemorySearchResult>>
  page(organizationId: string, pageId: string): Promise<MemoryPageDetail>
  reviews(organizationId: string): Promise<ReadonlyArray<MemoryReviewItem>>
  review(organizationId: string, proposalId: string, action: "approve" | "reject"): Promise<MemoryReviewResult>
  export(organizationId: string): Promise<MemoryExport>
}

export const DEFAULT_MEMORY_FILTERS: MemoryMapFilters = {
  query: "",
  topic: null,
  relationship: null,
  freshness: null,
  healthOnly: false,
  showIsolated: true
}

export const DEFAULT_MEMORY_VIEWPORT: MemoryViewport = { x: 0, y: 0, zoom: 1 }

const readLastView = (): MemorySubview => {
  try {
    const value = localStorage.getItem(LAST_VIEW_KEY)
    return value === "map" || value === "wiki" || value === "reviews" || value === "analytics"
      ? value
      : "dashboard"
  } catch {
    return "dashboard"
  }
}

const persistView = (view: MemorySubview): void => {
  try {
    localStorage.setItem(LAST_VIEW_KEY, view)
  } catch {
    // The live machine state remains authoritative in privacy mode.
  }
}

interface InitialData {
  readonly summary: MemoryDashboardSummary
  readonly graph: MemoryGraphView
  readonly reviews: ReadonlyArray<MemoryReviewItem>
}

interface NodeData {
  readonly graph: MemoryGraphView
  readonly page: MemoryPageDetail | null
}

export interface MemoryContext {
  readonly access: MemoryAccess | null
  readonly organizationId: string | null
  readonly view: MemorySubview
  readonly previousView: MemorySubview
  readonly range: string
  readonly summary: MemoryDashboardSummary | null
  readonly graph: MemoryGraphView | null
  readonly reviews: ReadonlyArray<MemoryReviewItem>
  readonly searchQuery: string
  readonly searchResults: ReadonlyArray<MemorySearchResult>
  readonly selectedNodeId: string | null
  readonly selectedEdgeId: string | null
  readonly selectedReviewId: string | null
  readonly page: MemoryPageDetail | null
  readonly evidence: MemoryEdgeEvidence | null
  readonly reviewResult: MemoryReviewResult | null
  readonly exported: MemoryExport | null
  readonly filters: MemoryMapFilters
  readonly viewport: MemoryViewport
  readonly error: string | null
}

export type MemoryEvent =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "RETRY" }
  | { type: "ORGANIZATION.CHANGE"; organizationId: string }
  | { type: "RANGE.CHANGE"; range: string }
  | { type: "NAVIGATE"; target: MemoryDeepLink }
  | { type: "MAP.FILTERS"; filters: MemoryMapFilters }
  | { type: "MAP.VIEWPORT"; viewport: MemoryViewport }
  | { type: "MAP.SELECT_NODE"; nodeId: string }
  | { type: "MAP.SELECT_EDGE"; edgeId: string }
  | { type: "MAP.EXPAND"; nodeId: string }
  | { type: "INSPECTOR.CLOSE" }
  | { type: "PAGE.OPEN"; pageId: string }
  | { type: "PAGE.BACK" }
  | { type: "SEARCH.QUERY"; query: string }
  | { type: "SEARCH.RUN" }
  | { type: "REVIEW.SELECT"; proposalId: string }
  | { type: "REVIEW.DECIDE"; proposalId: string; action: "approve" | "reject" }
  | { type: "EXPORT" }
  | { type: "EXPORT.CLEAR" }

const initialContext = (): MemoryContext => ({
  access: null,
  organizationId: null,
  view: readLastView(),
  previousView: "dashboard",
  range: "30d",
  summary: null,
  graph: null,
  reviews: [],
  searchQuery: "",
  searchResults: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  selectedReviewId: null,
  page: null,
  evidence: null,
  reviewResult: null,
  exported: null,
  filters: DEFAULT_MEMORY_FILTERS,
  viewport: DEFAULT_MEMORY_VIEWPORT,
  error: null
})

const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : "Team memory is temporarily unavailable."

const mergeGraph = (current: MemoryGraphView | null, added: MemoryGraphView): MemoryGraphView => {
  if (current === null) return added
  const nodes = new Map(current.nodes.map((node) => [node.id, node]))
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]))
  for (const node of added.nodes) nodes.set(node.id, node)
  for (const edge of added.edges) edges.set(edge.id, edge)
  return {
    ...current,
    totalNodes: Math.max(current.totalNodes, added.totalNodes),
    totalEdges: Math.max(current.totalEdges, added.totalEdges),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    clusters: current.clusters,
    truncated: current.truncated || added.truncated
  }
}

const linkFilters = (filters: MemoryMapFilters, filter: string | undefined): MemoryMapFilters => {
  if (filter === "stale") return { ...filters, freshness: "stale" }
  if (filter === "unhealthy") return { ...filters, healthOnly: true }
  if (filter === "hubs") return { ...filters, showIsolated: false }
  return filters
}

export const createMemoryMachine = (api: MemoryApi) =>
  setup({
    types: {
      context: {} as MemoryContext,
      events: {} as MemoryEvent
    },
    actors: {
      loadAccess: fromPromise(() => api.access()),
      loadInitial: fromPromise<InitialData, { organizationId: string; range: string }>(
        async ({ input }) => {
          const [summary, graph, reviews] = await Promise.all([
            api.dashboard(input.organizationId, input.range),
            api.graph(input.organizationId, 250),
            api.reviews(input.organizationId)
          ])
          return { summary, graph, reviews }
        }
      ),
      loadNode: fromPromise<NodeData, { organizationId: string; nodeId: string }>(
        async ({ input }) => {
          const graph = await api.neighborhood(input.organizationId, input.nodeId, 100)
          const node = graph.nodes.find((candidate) => candidate.id === input.nodeId)
          const page = node?.pageId ? await api.page(input.organizationId, node.pageId) : null
          return { graph, page }
        }
      ),
      loadEvidence: fromPromise<MemoryEdgeEvidence, { organizationId: string; edgeId: string }>(
        ({ input }) => api.evidence(input.organizationId, input.edgeId)
      ),
      loadPage: fromPromise<MemoryPageDetail, { organizationId: string; pageId: string }>(
        ({ input }) => api.page(input.organizationId, input.pageId)
      ),
      search: fromPromise<ReadonlyArray<MemorySearchResult>, { organizationId: string; query: string }>(
        ({ input }) => api.search(input.organizationId, input.query, 50)
      ),
      decideReview: fromPromise<MemoryReviewResult, { organizationId: string; proposalId: string; action: "approve" | "reject" }>(
        ({ input }) => api.review(input.organizationId, input.proposalId, input.action)
      ),
      exportMemory: fromPromise<MemoryExport, { organizationId: string }>(
        ({ input }) => api.export(input.organizationId)
      )
    },
    guards: {
      eligible: ({ context }) => context.access?.eligible === true && context.organizationId !== null
    },
    actions: {
      accessFailed: assign(({ event }) => ({ error: messageOf("error" in event ? event.error : null) })),
      clearOrganization: assign(({ event }) => {
        if (event.type !== "ORGANIZATION.CHANGE") return {}
        return {
          organizationId: event.organizationId,
          summary: null,
          graph: null,
          reviews: [],
          searchQuery: "",
          searchResults: [],
          selectedNodeId: null,
          selectedEdgeId: null,
          selectedReviewId: null,
          page: null,
          evidence: null,
          reviewResult: null,
          exported: null,
          filters: DEFAULT_MEMORY_FILTERS,
          viewport: DEFAULT_MEMORY_VIEWPORT,
          error: null
        }
      }),
      setFailure: assign(({ event }) => ({ error: messageOf("error" in event ? event.error : null) })),
      setRange: assign(({ event }) => event.type === "RANGE.CHANGE" ? { range: event.range } : {}),
      navigate: assign(({ context, event }) => {
        if (event.type !== "NAVIGATE") return {}
        persistView(event.target.view)
        return {
          view: event.target.view,
          page: null,
          previousView: context.view,
          filters: linkFilters(context.filters, event.target.filter),
          error: null
        }
      }),
      setFilters: assign(({ event }) => event.type === "MAP.FILTERS" ? { filters: event.filters } : {}),
      setViewport: assign(({ event }) => event.type === "MAP.VIEWPORT" ? { viewport: event.viewport } : {}),
      selectNode: assign(({ event }) => event.type === "MAP.SELECT_NODE" ? { selectedNodeId: event.nodeId, selectedEdgeId: null, evidence: null, page: null } : {}),
      selectEdge: assign(({ event }) => event.type === "MAP.SELECT_EDGE" ? { selectedEdgeId: event.edgeId, selectedNodeId: null, evidence: null, page: null } : {}),
      closeInspector: assign(() => ({ selectedNodeId: null, selectedEdgeId: null, evidence: null, page: null })),
      preparePage: assign(({ context }): Partial<MemoryContext> => ({ previousView: context.view, view: "wiki", page: null })),
      backFromPage: assign(({ context }) => ({ view: context.previousView, page: null })),
      setSearchQuery: assign(({ event }) => event.type === "SEARCH.QUERY" ? { searchQuery: event.query } : {}),
      clearSearch: assign(() => ({ searchResults: [] })),
      selectReview: assign(({ event }) => event.type === "REVIEW.SELECT" ? { selectedReviewId: event.proposalId, reviewResult: null } : {}),
      clearExport: assign(() => ({ exported: null }))
    }
  }).createMachine({
    id: "memory",
    initial: "checking",
    context: initialContext,
    states: {
      checking: {
        invoke: {
          id: "loadAccess",
          src: "loadAccess",
          onDone: {
            target: "closed",
            actions: assign(({ event }) => ({
              access: event.output,
              organizationId: event.output.selectedOrganizationId,
              error: null
            }))
          },
          onError: { target: "closed", actions: "accessFailed" }
        }
      },
      closed: {
        on: { OPEN: { guard: "eligible", target: "loading" } }
      },
      loading: {
        invoke: {
          id: "loadInitial",
          src: "loadInitial",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "", range: context.range }),
          onDone: {
            target: "ready",
            actions: assign(({ event }) => ({
              summary: event.output.summary,
              graph: event.output.graph,
              reviews: event.output.reviews,
              selectedReviewId: event.output.reviews[0]?.id ?? null,
              error: null
            }))
          },
          onError: { target: "failed", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "ORGANIZATION.CHANGE": { target: "loading", reenter: true, actions: "clearOrganization" } }
      },
      ready: {
        on: {
          CLOSE: "closed",
          RETRY: "loading",
          "ORGANIZATION.CHANGE": { target: "loading", actions: "clearOrganization" },
          "RANGE.CHANGE": { target: "loading", actions: "setRange" },
          NAVIGATE: { actions: "navigate" },
          "MAP.FILTERS": { actions: "setFilters" },
          "MAP.VIEWPORT": { actions: "setViewport" },
          "MAP.SELECT_NODE": { target: "nodeLoading", actions: "selectNode" },
          "MAP.SELECT_EDGE": { target: "edgeLoading", actions: "selectEdge" },
          "MAP.EXPAND": { target: "nodeLoading", actions: "selectNode" },
          "INSPECTOR.CLOSE": { actions: "closeInspector" },
          "PAGE.OPEN": { target: "pageLoading", actions: "preparePage" },
          "PAGE.BACK": { actions: "backFromPage" },
          "SEARCH.QUERY": { actions: "setSearchQuery" },
          "SEARCH.RUN": [
            { guard: ({ context }) => context.searchQuery.trim().length > 0, target: "searching" },
            { actions: "clearSearch" }
          ],
          "REVIEW.SELECT": { actions: "selectReview" },
          "REVIEW.DECIDE": { target: "reviewing" },
          EXPORT: { target: "exporting" },
          "EXPORT.CLEAR": { actions: "clearExport" }
        }
      },
      nodeLoading: {
        invoke: {
          id: "loadNode",
          src: "loadNode",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "", nodeId: context.selectedNodeId ?? "" }),
          onDone: {
            target: "ready",
            actions: assign(({ context, event }) => ({
              graph: mergeGraph(context.graph, event.output.graph),
              page: event.output.page,
              error: null
            }))
          },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "MAP.SELECT_NODE": { target: "nodeLoading", reenter: true, actions: "selectNode" }, "INSPECTOR.CLOSE": { target: "ready", actions: "closeInspector" } }
      },
      edgeLoading: {
        invoke: {
          id: "loadEvidence",
          src: "loadEvidence",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "", edgeId: context.selectedEdgeId ?? "" }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ evidence: event.output, error: null })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "MAP.SELECT_EDGE": { target: "edgeLoading", reenter: true, actions: "selectEdge" }, "INSPECTOR.CLOSE": { target: "ready", actions: "closeInspector" } }
      },
      pageLoading: {
        invoke: {
          id: "loadPage",
          src: "loadPage",
          input: ({ context, event }) => ({ organizationId: context.organizationId ?? "", pageId: event.type === "PAGE.OPEN" ? event.pageId : "" }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ page: event.output, error: null })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "PAGE.BACK": { target: "ready", actions: "backFromPage" } }
      },
      searching: {
        invoke: {
          id: "search",
          src: "search",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "", query: context.searchQuery }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ searchResults: event.output, error: null })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "SEARCH.QUERY": { target: "ready", actions: "setSearchQuery" } }
      },
      reviewing: {
        invoke: {
          id: "decideReview",
          src: "decideReview",
          input: ({ context, event }) => ({
            organizationId: context.organizationId ?? "",
            proposalId: event.type === "REVIEW.DECIDE" ? event.proposalId : "",
            action: event.type === "REVIEW.DECIDE" ? event.action : "reject"
          }),
          onDone: [
            {
              guard: ({ event }) => event.output.status === "conflict",
              target: "conflict",
              actions: assign(({ event }) => ({ reviewResult: event.output }))
            },
            {
              target: "ready",
              actions: assign(({ context, event }) => {
                const status = event.output.status === "accepted" ? "accepted" : "rejected"
                return {
                  reviewResult: event.output,
                  reviews: context.reviews.map((review) =>
                    review.id === event.output.proposalId
                      ? { ...review, status }
                      : review
                  )
                }
              })
            }
          ],
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed" }
      },
      conflict: {
        on: { CLOSE: "closed", "REVIEW.SELECT": { target: "ready", actions: "selectReview" }, RETRY: "loading" }
      },
      exporting: {
        invoke: {
          id: "exportMemory",
          src: "exportMemory",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "" }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ exported: event.output })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed" }
      },
      failed: {
        on: { CLOSE: "closed", RETRY: "loading", "ORGANIZATION.CHANGE": { target: "loading", actions: "clearOrganization" } }
      }
    }
  })
