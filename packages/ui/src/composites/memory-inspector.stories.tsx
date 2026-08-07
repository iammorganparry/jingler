import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { MemoryInspector } from "./memory-inspector.js"
import {
  memoryEdgeEvidence,
  memoryInspectorNode,
  memoryPageDetail,
  memorySuggestions
} from "./memory.mock.js"

/**
 * The right-hand inspector drawer. It positions itself absolutely against the
 * map surface, so every story frames it in a sized `relative` container with a
 * hint of the graph plane behind it.
 */
const meta: Meta<typeof MemoryInspector> = {
  title: "Composites/Memory/Inspector",
  component: MemoryInspector,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="relative h-[760px] w-full overflow-hidden bg-sunken text-text">
        <div className="grid h-full place-items-center text-[11px] text-dim">Memory map surface</div>
        {Story()}
      </div>
    )
  ],
  args: {
    onBack: fn(),
    onOpenPage: fn(),
    onExpandNeighborhood: fn(),
    onPromoteSuggestion: fn()
  }
}
export default meta
type Story = StoryObj<typeof MemoryInspector>

/** A fully-loaded page: node header, summary, citations, provenance, and the
 * advisory suggestions panel. */
export const PageSelected: Story = {
  args: {
    node: memoryInspectorNode,
    evidence: null,
    page: memoryPageDetail,
    suggestions: memorySuggestions,
    suggestionsSource: "turbopuffer"
  }
}

/** A node selected before its page detail has streamed in. */
export const NodeOnly: Story = {
  args: { node: memoryInspectorNode, evidence: null, page: null }
}

/** Accepted evidence for a selected relationship edge (no node/page). */
export const EdgeEvidence: Story = {
  args: { node: null, evidence: memoryEdgeEvidence, page: null }
}

/** Node selected, detail still loading. */
export const Loading: Story = {
  args: { node: memoryInspectorNode, evidence: null, page: null, loading: true }
}
