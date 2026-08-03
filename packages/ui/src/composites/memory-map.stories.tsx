import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { useState } from "react"
import { MemoryMap } from "./memory-map.js"
import type { MemoryMapFilters, MemoryViewport } from "./memory-map.js"
import {
  memoryDefaultFilters,
  memoryDefaultViewport,
  memoryGraphView,
  memoryGraphViewLarge,
  memoryNodePositions
} from "./memory.mock.js"

/**
 * The bounded memory graph — an interactive WebGL (three.js) force-directed 3D
 * scene on the left and the synchronized, keyboard-accessible node/relationship
 * lists on the right. Nodes are sized by degree, coloured by kind and health,
 * and edges carry directional particle flow; drag to orbit, scroll to zoom,
 * right-click a node to expand its neighbourhood. The scene needs a measurable
 * box, so every story frames it in a fixed-height flex column.
 *
 * The default story is a working harness: the filter bar, the pan/zoom controls,
 * and node/edge selection are all wired to real local state.
 */
const meta: Meta<typeof MemoryMap> = {
  title: "Composites/Memory/Map",
  component: MemoryMap,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[760px] w-full flex-col overflow-hidden bg-panel text-text">
        {Story()}
      </div>
    )
  ]
}
export default meta
type Story = StoryObj<typeof MemoryMap>

function MapHarness({ large = false }: { large?: boolean }) {
  const [filters, setFilters] = useState<MemoryMapFilters>(memoryDefaultFilters)
  const [viewport, setViewport] = useState<MemoryViewport>(memoryDefaultViewport)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("page-auth-overview")
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  return (
    <MemoryMap
      graph={large ? memoryGraphViewLarge : memoryGraphView}
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
  )
}

/** Fully interactive: filter, pan, zoom, and select nodes and edges. */
export const Interactive: Story = {
  render: () => <MapHarness />
}

/** A large, bounded vault — the "N/total · bounded" readout is populated. */
export const LargeVault: Story = {
  render: () => <MapHarness large />
}

/** Static populated state with the default fitted viewport. */
export const Populated: Story = {
  args: {
    graph: memoryGraphView,
    positions: memoryNodePositions,
    filters: memoryDefaultFilters,
    viewport: memoryDefaultViewport,
    selectedNodeId: "page-billing-overview",
    selectedEdgeId: null,
    onSelectNode: fn(),
    onSelectEdge: fn(),
    onExpandNode: fn(),
    onViewportChange: fn(),
    onFiltersChange: fn()
  }
}

/** Only the health findings, via the "Findings" filter toggle. */
export const HealthFindingsOnly: Story = {
  args: {
    graph: memoryGraphView,
    positions: memoryNodePositions,
    filters: { ...memoryDefaultFilters, healthOnly: true },
    viewport: memoryDefaultViewport,
    selectedNodeId: "page-orphan-legacy",
    selectedEdgeId: null,
    onSelectNode: fn(),
    onSelectEdge: fn(),
    onExpandNode: fn(),
    onViewportChange: fn(),
    onFiltersChange: fn()
  }
}

/** Graph still loading. */
export const Loading: Story = {
  args: {
    graph: null,
    positions: [],
    filters: memoryDefaultFilters,
    viewport: memoryDefaultViewport,
    selectedNodeId: null,
    selectedEdgeId: null,
    loading: true,
    onSelectNode: fn(),
    onSelectEdge: fn(),
    onExpandNode: fn(),
    onViewportChange: fn(),
    onFiltersChange: fn()
  }
}

/** No graph data. */
export const Empty: Story = {
  args: {
    graph: null,
    positions: [],
    filters: memoryDefaultFilters,
    viewport: memoryDefaultViewport,
    selectedNodeId: null,
    selectedEdgeId: null,
    onSelectNode: fn(),
    onSelectEdge: fn(),
    onExpandNode: fn(),
    onViewportChange: fn(),
    onFiltersChange: fn()
  }
}
