import { useMachine } from "@xstate/react"
import { useQuery } from "@tanstack/react-query"
import type { MemoryDeepLink, MemoryMapFilters, MemoryNodePosition, MemoryViewport } from "@jingler/ui"
import { useCallback, useEffect } from "react"
import { createMemoryMachine } from "./memory-machine.js"
import { rpc } from "./rpc-client.js"
import type { MemoryLayoutRequest, MemoryLayoutResponse } from "./memory-layout.worker.js"

const memoryMachine = createMemoryMachine({
  access: rpc.memoryAccess,
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
  reviews: rpc.memoryReviews,
  review: rpc.memoryReview,
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
    queryKey: ["memory-layout", graph?.nodes ?? [], graph?.edges ?? []],
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
  const selectReview = useCallback((proposalId: string) => send({ type: "REVIEW.SELECT", proposalId }), [send])
  const decideReview = useCallback((proposalId: string, action: "approve" | "reject") => send({ type: "REVIEW.DECIDE", proposalId, action }), [send])
  const requestExport = useCallback(() => send({ type: "EXPORT" }), [send])

  const selectedNode = graph?.nodes.find((node) => node.id === snapshot.context.selectedNodeId) ?? null
  const canReview =
    snapshot.context.access?.organizations
      .find((organization) => organization.id === snapshot.context.organizationId)
      ?.privileges.includes("review") ?? false

  return {
    active: !(snapshot.matches("checking") || snapshot.matches("closed")),
    eligible: snapshot.context.access?.eligible ?? false,
    loading: snapshot.matches("checking") || snapshot.matches("loading") || snapshot.matches("nodeLoading") || snapshot.matches("edgeLoading") || snapshot.matches("pageLoading") || snapshot.matches("searching"),
    reviewing: snapshot.matches("reviewing"),
    exporting: snapshot.matches("exporting"),
    conflict: snapshot.context.reviewResult?.status === "conflict",
    context: snapshot.context,
    positions,
    selectedNode,
    canReview,
    open,
    close,
    retry,
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
    selectReview,
    decideReview,
    requestExport
  }
}
