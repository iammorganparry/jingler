import { useMachine } from "@xstate/react"
import { useQuery } from "@tanstack/react-query"
import type { MemoryDeepLink, MemoryMapFilters, MemoryNodePosition, MemoryViewport } from "@jingler/ui"
import { useCallback, useEffect } from "react"
import { createMemoryMachine } from "./memory-machine.js"
import { rpc } from "./rpc-client.js"
import type { MemoryLayoutRequest, MemoryLayoutResponse } from "./memory-layout.worker.js"

const graphIdentity = new WeakMap<object, number>()
let nextGraphIdentity = 1

const layoutIdentity = (graph: object | null): number => {
  if (graph === null) return 0
  const existing = graphIdentity.get(graph)
  if (existing !== undefined) return existing
  const identity = nextGraphIdentity++
  graphIdentity.set(graph, identity)
  return identity
}

const memoryMachine = createMemoryMachine({
  access: rpc.memoryAccess,
  recover: rpc.memoryRecover,
  configure: async (organizationId) => {
    await rpc.memoryConfigure({ enabled: true, organizationId })
    return rpc.memoryAccess()
  },
  dashboard: rpc.memoryDashboard,
  graph: rpc.memoryGraph,
  neighborhood: rpc.memoryNeighborhood,
  evidence: rpc.memoryEdgeEvidence,
  search: rpc.memorySearch,
  page: rpc.memoryPage,
  export: rpc.memoryExport,
  suggestions: rpc.memorySuggestions
})

const LAYOUT_REQUEST_ID = 1

const calculateMemoryLayout = (
  request: MemoryLayoutRequest,
  signal: AbortSignal
): Promise<ReadonlyArray<MemoryNodePosition>> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./memory-layout.worker.ts", import.meta.url), {
      type: "module",
      name: "jingler-memory-layout"
    })
    const dispose = (): void => {
      signal.removeEventListener("abort", abort)
      worker.terminate()
    }
    const abort = (): void => {
      dispose()
      reject(new DOMException("Memory layout cancelled", "AbortError"))
    }
    worker.onmessage = (event: MessageEvent<MemoryLayoutResponse>) => {
      if (event.data.requestId !== request.requestId) return
      dispose()
      resolve(event.data.positions)
    }
    worker.onerror = (event) => {
      dispose()
      reject(new Error(event.message || "Memory layout worker failed"))
    }
    signal.addEventListener("abort", abort, { once: true })
    worker.postMessage(request)
  })

export function useMemory() {
  const [snapshot, send] = useMachine(memoryMachine)
  const graph = snapshot.context.graph
  const layout = useQuery({
    // The graph is immutable machine output; avoid hashing every node and edge on every render.
    queryKey: ["memory-layout", layoutIdentity(graph)],
    enabled: graph !== null,
    queryFn: ({ signal }) =>
      calculateMemoryLayout(
        {
          requestId: LAYOUT_REQUEST_ID,
          nodes: graph?.nodes ?? [],
          edges: graph?.edges ?? []
        },
        signal
      ),
    staleTime: Number.POSITIVE_INFINITY
  })
  const positions = graph === null ? [] : (layout.data ?? [])

  useEffect(() => {
    if (!snapshot.context.searchQuery.trim()) {
      send({ type: "SEARCH.RUN" })
      return
    }
    const timer = window.setTimeout(() => send({ type: "SEARCH.RUN" }), 220)
    return () => window.clearTimeout(timer)
  }, [send, snapshot.context.searchQuery])

  // The Export button flashes "Exported" once the archive is saved; reset it a
  // few seconds later so it doesn't stick until the next organization switch.
  const exported = snapshot.context.exported
  useEffect(() => {
    if (exported === null) return
    const timer = window.setTimeout(() => send({ type: "EXPORT.CLEAR" }), 4000)
    return () => window.clearTimeout(timer)
  }, [exported, send])

  const open = useCallback(() => send({ type: "OPEN" }), [send])
  const close = useCallback(() => send({ type: "CLOSE" }), [send])
  const retry = useCallback(() => send({ type: "RETRY" }), [send])
  const recover = useCallback(() => send({ type: "RECOVER" }), [send])
  const changeOrganization = useCallback((organizationId: string) => send({ type: "ORGANIZATION.CHANGE", organizationId }), [send])
  const changeRange = useCallback((range: string) => send({ type: "RANGE.CHANGE", range }), [send])
  const navigate = useCallback((target: MemoryDeepLink) => send({ type: "NAVIGATE", target }), [send])
  const setFilters = useCallback((filters: MemoryMapFilters) => send({ type: "MAP.FILTERS", filters }), [send])
  const setViewport = useCallback((viewport: MemoryViewport) => send({ type: "MAP.VIEWPORT", viewport }), [send])
  const selectNode = useCallback((nodeId: string) => send({ type: "MAP.SELECT_NODE", nodeId }), [send])
  const selectEdge = useCallback((edgeId: string) => send({ type: "MAP.SELECT_EDGE", edgeId }), [send])
  const expandNode = useCallback((nodeId: string) => send({ type: "MAP.EXPAND", nodeId }), [send])
  const closeInspector = useCallback(() => send({ type: "INSPECTOR.CLOSE" }), [send])
  const openPage = useCallback((pageId: string) => send({ type: "PAGE.OPEN", pageId }), [send])
  const backFromPage = useCallback(() => send({ type: "PAGE.BACK" }), [send])
  const setQuery = useCallback((query: string) => send({ type: "SEARCH.QUERY", query }), [send])
  const requestExport = useCallback(() => send({ type: "EXPORT" }), [send])

  const selectedNode = graph?.nodes.find((node) => node.id === snapshot.context.selectedNodeId) ?? null

  return {
    active: !(snapshot.matches("checking") || snapshot.matches("closed")),
    eligible: snapshot.context.access?.eligible ?? false,
    loading: snapshot.matches("checking") || snapshot.matches("loading") || snapshot.matches("nodeLoading") || snapshot.matches("edgeLoading") || snapshot.matches("pageLoading") || snapshot.matches("searching"),
    exporting: snapshot.matches("exporting"),
    recovering: snapshot.matches("recovering"),
    context: snapshot.context,
    positions,
    selectedNode,
    open,
    close,
    retry,
    recover,
    changeOrganization,
    changeRange,
    navigate,
    setFilters,
    setViewport,
    selectNode,
    selectEdge,
    expandNode,
    closeInspector,
    openPage,
    backFromPage,
    setQuery,
    requestExport
  }
}
