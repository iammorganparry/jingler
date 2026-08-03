import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { useMemo, useState } from "react"
import { MemoryAnalytics } from "./memory-analytics.js"
import { MemoryBrowser } from "./memory-browser.js"
import { MemoryDashboard } from "./memory-dashboard.js"
import type { MemorySubview } from "./memory-dashboard.js"
import { MemoryMap } from "./memory-map.js"
import type { MemoryMapFilters, MemoryViewport } from "./memory-map.js"
import {
  memoryDashboardSummary,
  memoryDefaultFilters,
  memoryDefaultViewport,
  memoryGraphView,
  memoryNodePositions,
  memoryPageDetailsById,
  memorySearchResults
} from "./memory.mock.js"

/**
 * The whole Memory destination assembled the way the app arranges it: a subview
 * switcher across the top (Dashboard · Map · Browser · Analytics) with
 * the matching composite below, all fed from the shared mock vault.
 *
 * This shell is deliberately story-local and presentational — it exists only to
 * review the page end-to-end in one Storybook entry. It is NOT exported from the
 * library; the real destination composes these same composites in the renderer.
 */
const meta: Meta = { title: "Composites/Memory/Page", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

type PageView = Extract<MemorySubview, "dashboard" | "map" | "wiki" | "analytics">

const TABS: ReadonlyArray<{ id: PageView; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "map", label: "Map" },
  { id: "wiki", label: "Browser" },
  { id: "analytics", label: "Analytics" }
]

function MemoryPageShell() {
  const [view, setView] = useState<PageView>("dashboard")

  // Map sub-state.
  const [filters, setFilters] = useState<MemoryMapFilters>(memoryDefaultFilters)
  const [viewport, setViewport] = useState<MemoryViewport>(memoryDefaultViewport)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("page-auth-overview")
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  // Browser sub-state.
  const [query, setQuery] = useState("")
  const [openPageId, setOpenPageId] = useState<string | null>(null)
  const [browserFilter, setBrowserFilter] = useState<string | null>(null)
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === "") return memorySearchResults
    return memorySearchResults.filter(
      (result) =>
        result.title.toLowerCase().includes(q) ||
        result.snippet.toLowerCase().includes(q) ||
        result.path.toLowerCase().includes(q)
    )
  }, [query])

  const openInBrowser = (pageId: string) => {
    setOpenPageId(pageId)
    setView("wiki")
  }

  return (
    <div className="flex h-[820px] w-full flex-col overflow-hidden bg-panel text-text">
      <header className="flex flex-none items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-blue">Team memory</span>
        <nav className="flex items-center gap-1" aria-label="Memory subviews">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={view === tab.id ? "page" : undefined}
              onClick={() => setView(tab.id)}
              className="rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-surface aria-[current=page]:text-text-bright"
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {view === "dashboard" && (
          <MemoryDashboard
            summary={memoryDashboardSummary}
            onNavigate={(target) => {
              if (target.view !== "reviews") setView(target.view)
              if (target.view === "wiki") setBrowserFilter(target.filter ?? null)
            }}
            onRetry={fn()}
          />
        )}

        {view === "map" && (
          <MemoryMap
            graph={memoryGraphView}
            positions={memoryNodePositions}
            filters={filters}
            viewport={viewport}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectNode={(id) => {
              setSelectedNodeId(id)
              setSelectedEdgeId(null)
            }}
            onSelectEdge={(id) => {
              setSelectedEdgeId(id)
              setSelectedNodeId(null)
            }}
            onExpandNode={setSelectedNodeId}
            onViewportChange={setViewport}
            onFiltersChange={setFilters}
          />
        )}

        {view === "wiki" && (
          <MemoryBrowser
            query={query}
            results={results}
            page={openPageId ? (memoryPageDetailsById[openPageId] ?? null) : null}
            filter={browserFilter}
            onQueryChange={setQuery}
            onOpenPage={openInBrowser}
            onBack={() => setOpenPageId(null)}
          />
        )}

        {view === "analytics" && <MemoryAnalytics summary={memoryDashboardSummary} />}
      </main>
    </div>
  )
}

/** The full Memory page — switch subviews from the top bar. */
export const Page: Story = {
  render: () => <MemoryPageShell />
}
