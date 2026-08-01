import { useMachine } from "@xstate/react"
import type { MemoryGraphEdgeKind } from "@jingler/contracts"
import type { MemoryDeepLink, MemoryMapFilters, MemoryNodePosition, MemoryViewport } from "@jingler/ui"
import { useCallback, useEffect, useRef, useState } from "react"
import { createMemoryMachine } from "./memory-machine.js"
import { rpc } from "./rpc-client.js"
import type { MemoryLayoutRequest, MemoryLayoutResponse } from "./memory-layout.worker.js"

const memoryMachine = createMemoryMachine({
  access: rpc.memoryAccess,
  dashboard: rpc.memoryDashboard,
  graph: rpc.memoryGraph,
  neighborhood: rpc.memoryNeighborhood,
  evidence: rpc.memoryEdgeEvidence,
  search: rpc.memorySearch,
  page: rpc.memoryPage,
  reviews: rpc.memoryReviews,
  review: rpc.memoryReview,
  export: rpc.memoryExport
})

export function useMemory() {
  const [snapshot, send] = useMachine(memoryMachine)
  const [positions, setPositions] = useState<ReadonlyArray<MemoryNodePosition>>([])
  const requestId = useRef(0)
  const graph = snapshot.context.graph

  useEffect(() => {
    if (graph === null) {
      setPositions([])
      return
    }
    const nextRequestId = requestId.current + 1
    requestId.current = nextRequestId
    const worker = new Worker(new URL("./memory-layout.worker.ts", import.meta.url), {
      type: "module",
      name: "jingler-memory-layout"
    })
    worker.onmessage = (event: MessageEvent<MemoryLayoutResponse>) => {
      if (event.data.requestId === requestId.current) setPositions(event.data.positions)
    }
    const request: MemoryLayoutRequest = {
      requestId: nextRequestId,
      nodes: graph.nodes,
      edges: graph.edges
    }
    worker.postMessage(request)
    return () => worker.terminate()
  }, [graph])

  useEffect(() => {
    if (!snapshot.context.searchQuery.trim()) {
      send({ type: "SEARCH.RUN" })
      return
    }
    const timer = window.setTimeout(() => send({ type: "SEARCH.RUN" }), 220)
    return () => window.clearTimeout(timer)
  }, [send, snapshot.context.searchQuery])

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

  const downloadExport = useCallback(() => {
    const exported = snapshot.context.exported
    if (exported === null) return
    const binary = Uint8Array.from(atob(exported.content), (character) => character.charCodeAt(0))
    const blob = new Blob([binary.buffer], { type: exported.mediaType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = exported.filename
    anchor.click()
    URL.revokeObjectURL(url)
    send({ type: "EXPORT.CLEAR" })
  }, [send, snapshot.context.exported])

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
    conflict: snapshot.matches("conflict"),
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
    requestExport,
    downloadExport
  }
}

export const relationshipFilterLabel = (relationship: MemoryGraphEdgeKind | null): string =>
  relationship === null ? "All relationships" : relationship
