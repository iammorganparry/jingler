import type {
  MemoryAccess,
  MemoryCaptureRecovery,
  MemoryDashboardSummary,
  MemoryEdgeEvidence,
  MemoryExport,
  MemoryGraphView,
  MemoryPageDetail,
  MemorySearchResult,
  MemorySuggestionsView
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
  recover(): Promise<MemoryCaptureRecovery>
  configure(organizationId: string): Promise<MemoryAccess>
  dashboard(organizationId: string, range: string): Promise<MemoryDashboardSummary>
  graph(organizationId: string, limit: number): Promise<MemoryGraphView>
  neighborhood(organizationId: string, nodeId: string, limit: number): Promise<MemoryGraphView>
  evidence(organizationId: string, edgeId: string): Promise<MemoryEdgeEvidence>
  search(organizationId: string, query: string, limit: number): Promise<ReadonlyArray<MemorySearchResult>>
  page(organizationId: string, pageId: string): Promise<MemoryPageDetail>
  export(organizationId: string): Promise<MemoryExport>
  /** Advisory relatedness suggestions for one page (NON-AUTHORITATIVE). */
  suggestions(organizationId: string, pageId: string, limit: number): Promise<MemorySuggestionsView>
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
    return value === "map" || value === "wiki" || value === "analytics"
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
  readonly searchResults: ReadonlyArray<MemorySearchResult>
}

interface NodeData {
  readonly graph: MemoryGraphView
  readonly page: MemoryPageDetail | null
  readonly suggestions: MemorySuggestionsView | null
}

export interface MemoryContext {
  readonly access: MemoryAccess | null
  readonly organizationId: string | null
  readonly view: MemorySubview
  readonly previousView: MemorySubview
  readonly range: string
  readonly summary: MemoryDashboardSummary | null
  readonly graph: MemoryGraphView | null
  readonly searchQuery: string
  readonly searchResults: ReadonlyArray<MemorySearchResult>
  readonly selectedNodeId: string | null
  readonly selectedEdgeId: string | null
  readonly page: MemoryPageDetail | null
  readonly suggestions: MemorySuggestionsView | null
  readonly evidence: MemoryEdgeEvidence | null
  readonly exported: MemoryExport | null
  readonly recovery: MemoryCaptureRecovery | null
  readonly filters: MemoryMapFilters
  readonly viewport: MemoryViewport
  readonly error: string | null
  /**
   * A debounced SEARCH.RUN that fired while the machine was busy (a page/node/edge
   * load or an export). The busy state can't run the query, so it records
   * this flag and `ready` consumes it on re-entry — otherwise the query is dropped.
   */
  readonly searchPending: boolean
}

export type MemoryEvent =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "RETRY" }
  | { type: "RECOVER" }
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
  searchQuery: "",
  searchResults: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  page: null,
  suggestions: null,
  evidence: null,
  exported: null,
  recovery: null,
  filters: DEFAULT_MEMORY_FILTERS,
  viewport: DEFAULT_MEMORY_VIEWPORT,
  error: null,
  searchPending: false
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
      configure: fromPromise<MemoryAccess, { organizationId: string }>(
        ({ input }) => api.configure(input.organizationId)
      ),
      loadInitial: fromPromise<InitialData, { organizationId: string; range: string; query: string }>(
        async ({ input }) => {
          const [summary, graph, searchResults] = await Promise.all([
            api.dashboard(input.organizationId, input.range),
            api.graph(input.organizationId, 250),
            input.query.trim() === ""
              ? Promise.resolve([])
              : api.search(input.organizationId, input.query, 50)
          ])
          return { summary, graph, searchResults }
        }
      ),
      loadNode: fromPromise<NodeData, { organizationId: string; nodeId: string }>(
        async ({ input }) => {
          const graph = await api.neighborhood(input.organizationId, input.nodeId, 100)
          const node = graph.nodes.find((candidate) => candidate.id === input.nodeId)
          const pageId = node?.pageId
          const [page, suggestions] = await Promise.all([
            pageId ? api.page(input.organizationId, pageId) : Promise.resolve(null),
            // Advisory-only; a failure must never break the authoritative inspector.
            pageId
              ? api
                  .suggestions(input.organizationId, pageId, 5)
                  .catch(() => null)
              : Promise.resolve(null)
          ])
          return { graph, page, suggestions }
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
      exportMemory: fromPromise<MemoryExport, { organizationId: string }>(
        ({ input }) => api.export(input.organizationId)
      ),
      recoverMemory: fromPromise(() => api.recover())
    },
    guards: {
      eligible: ({ context }) => context.access?.eligible === true && context.organizationId !== null,
      canConfigure: ({ context }) => (context.access?.organizations.length ?? 0) > 0
    },
    actions: {
      accessFailed: assign(({ event }) => ({ error: messageOf("error" in event ? event.error : null) })),
      clearOrganization: assign(({ event }) => {
        if (event.type !== "ORGANIZATION.CHANGE") return {}
        return {
          organizationId: event.organizationId,
          summary: null,
          graph: null,
          searchQuery: "",
          searchResults: [],
          selectedNodeId: null,
          selectedEdgeId: null,
          page: null,
          suggestions: null,
          evidence: null,
          exported: null,
          recovery: null,
          filters: DEFAULT_MEMORY_FILTERS,
          viewport: DEFAULT_MEMORY_VIEWPORT,
          error: null,
          searchPending: false
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
      navigateFailed: assign(({ context, event }) => {
        if (event.type !== "NAVIGATE") return {}
        persistView(event.target.view)
        return {
          view: event.target.view,
          page: null,
          previousView: context.view,
          filters: linkFilters(context.filters, event.target.filter)
        }
      }),
      setFilters: assign(({ event }) => event.type === "MAP.FILTERS" ? { filters: event.filters } : {}),
      setViewport: assign(({ event }) => event.type === "MAP.VIEWPORT" ? { viewport: event.viewport } : {}),
      selectNode: assign(({ event }) =>
        event.type === "MAP.SELECT_NODE" || event.type === "MAP.EXPAND"
          ? { selectedNodeId: event.nodeId, selectedEdgeId: null, evidence: null, page: null, suggestions: null }
          : {}
      ),
      selectEdge: assign(({ event }) => event.type === "MAP.SELECT_EDGE" ? { selectedEdgeId: event.edgeId, selectedNodeId: null, evidence: null, page: null, suggestions: null } : {}),
      closeInspector: assign(() => ({ selectedNodeId: null, selectedEdgeId: null, evidence: null, page: null, suggestions: null })),
      preparePage: assign(({ context }): Partial<MemoryContext> => ({ previousView: context.view, view: "wiki", page: null })),
      backFromPage: assign(({ context }) => ({ view: context.previousView, page: null })),
      setSearchQuery: assign(({ event }) => event.type === "SEARCH.QUERY" ? { searchQuery: event.query } : {}),
      clearSearch: assign(() => ({ searchResults: [] })),
      markSearchPending: assign(() => ({ searchPending: true })),
      consumeSearchPending: assign(() => ({ searchPending: false })),
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
        on: {
          OPEN: [
            { guard: "eligible", target: "loading" },
            { guard: "canConfigure", target: "setup" }
          ]
        }
      },
      setup: {
        on: {
          CLOSE: "closed",
          "ORGANIZATION.CHANGE": { target: "configuring", actions: "clearOrganization" }
        }
      },
      configuring: {
        invoke: {
          src: "configure",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "" }),
          onDone: {
            target: "loading",
            actions: assign(({ event }) => ({
              access: event.output,
              organizationId: event.output.selectedOrganizationId,
              error: null
            }))
          },
          onError: { target: "failed", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "SEARCH.QUERY": { actions: "setSearchQuery" }, "SEARCH.RUN": { actions: "markSearchPending" } }
      },
      loading: {
        invoke: {
          id: "loadInitial",
          src: "loadInitial",
          input: ({ context }) => ({
            organizationId: context.organizationId ?? "",
            range: context.range,
            query: context.searchQuery
          }),
          onDone: {
            target: "ready",
            actions: assign(({ event }) => ({
              summary: event.output.summary,
              graph: event.output.graph,
              searchResults: event.output.searchResults,
              selectedNodeId: null,
              selectedEdgeId: null,
              page: null,
              suggestions: null,
              evidence: null,
              error: null
            }))
          },
          onError: { target: "failed", actions: "setFailure" }
        },
        on: {
          CLOSE: "closed",
          "ORGANIZATION.CHANGE": { target: "configuring", actions: "clearOrganization" },
          "SEARCH.QUERY": { actions: "setSearchQuery" },
          "SEARCH.RUN": { actions: "markSearchPending" }
        }
      },
      ready: {
        // Drain a SEARCH.RUN that fired while a sibling load was in flight. The
        // busy state only recorded the intent; `ready` is where the query can
        // actually run (or clear, if the box was emptied meanwhile).
        always: [
          {
            guard: ({ context }) => context.searchPending && context.searchQuery.trim().length > 0,
            target: "searching",
            actions: "consumeSearchPending"
          },
          {
            guard: ({ context }) => context.searchPending,
            actions: ["consumeSearchPending", "clearSearch"]
          }
        ],
        on: {
          CLOSE: "closed",
          RETRY: "loading",
          "ORGANIZATION.CHANGE": { target: "configuring", actions: "clearOrganization" },
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
              suggestions: event.output.suggestions,
              error: null
            }))
          },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "MAP.SELECT_NODE": { target: "nodeLoading", reenter: true, actions: "selectNode" }, "INSPECTOR.CLOSE": { target: "ready", actions: "closeInspector" }, "SEARCH.QUERY": { actions: "setSearchQuery" }, "SEARCH.RUN": { actions: "markSearchPending" } }
      },
      edgeLoading: {
        invoke: {
          id: "loadEvidence",
          src: "loadEvidence",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "", edgeId: context.selectedEdgeId ?? "" }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ evidence: event.output, error: null })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "MAP.SELECT_EDGE": { target: "edgeLoading", reenter: true, actions: "selectEdge" }, "INSPECTOR.CLOSE": { target: "ready", actions: "closeInspector" }, "SEARCH.QUERY": { actions: "setSearchQuery" }, "SEARCH.RUN": { actions: "markSearchPending" } }
      },
      pageLoading: {
        invoke: {
          id: "loadPage",
          src: "loadPage",
          input: ({ context, event }) => ({ organizationId: context.organizationId ?? "", pageId: event.type === "PAGE.OPEN" ? event.pageId : "" }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ page: event.output, error: null })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "PAGE.BACK": { target: "ready", actions: "backFromPage" }, "SEARCH.QUERY": { actions: "setSearchQuery" }, "SEARCH.RUN": { actions: "markSearchPending" } }
      },
      searching: {
        invoke: {
          id: "search",
          src: "search",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "", query: context.searchQuery }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ searchResults: event.output, error: null })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "SEARCH.QUERY": { target: "ready", actions: "setSearchQuery" }, "SEARCH.RUN": { actions: "markSearchPending" } }
      },
      exporting: {
        invoke: {
          id: "exportMemory",
          src: "exportMemory",
          input: ({ context }) => ({ organizationId: context.organizationId ?? "" }),
          onDone: { target: "ready", actions: assign(({ event }) => ({ exported: event.output })) },
          onError: { target: "ready", actions: "setFailure" }
        },
        on: { CLOSE: "closed", "SEARCH.QUERY": { actions: "setSearchQuery" }, "SEARCH.RUN": { actions: "markSearchPending" } }
      },
      recovering: {
        invoke: {
          id: "recoverMemory",
          src: "recoverMemory",
          onDone: {
            target: "loading",
            actions: assign(({ event }) => ({ recovery: event.output, error: null }))
          },
          onError: { target: "failed", actions: "setFailure" }
        },
        on: { CLOSE: "closed" }
      },
      failed: {
        // Route through `configuring` like every other state: a selection made in
        // the error state must be persisted (Config.setMemory) and refresh access,
        // not jump straight to `loading` with stale access and an unsaved choice.
        on: {
          CLOSE: "closed",
          RETRY: "loading",
          RECOVER: "recovering",
          NAVIGATE: { actions: "navigateFailed" },
          "ORGANIZATION.CHANGE": { target: "configuring", actions: "clearOrganization" }
        }
      }
    }
  })
