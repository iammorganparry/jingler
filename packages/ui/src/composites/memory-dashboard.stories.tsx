import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { MemoryDashboard } from "./memory-dashboard.js"
import {
  memoryDashboardSummary,
  memoryDashboardSummaryLarge,
  memoryDashboardSummaryNascent
} from "./memory.mock.js"

/**
 * The Memory overview dashboard — six metric cards plus the weekly-growth bars
 * and the privacy-safe retrieval panel. Every card is a deep link, wired here
 * to a Storybook action so the target subview is logged on click.
 */
const meta: Meta<typeof MemoryDashboard> = {
  title: "Composites/Memory/Dashboard",
  component: MemoryDashboard,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[760px] w-full flex-col overflow-hidden bg-panel text-text">
        {Story()}
      </div>
    )
  ],
  args: { onNavigate: fn(), onRetry: fn() }
}
export default meta
type Story = StoryObj<typeof MemoryDashboard>

export const Populated: Story = {
  args: { summary: memoryDashboardSummary }
}

/** A much larger vault — bigger counts, taller growth bars. */
export const LargeVault: Story = {
  args: { summary: memoryDashboardSummaryLarge }
}

/** A young vault with no completed-review timing yet (median is null). */
export const NascentVault: Story = {
  args: { summary: memoryDashboardSummaryNascent }
}

/** Still refreshing on top of already-loaded data. */
export const Refreshing: Story = {
  args: { summary: memoryDashboardSummary, loading: true }
}

/** First load, nothing to show yet. */
export const Loading: Story = {
  args: { summary: null, loading: true }
}

/** The summary failed to load — offers a retry. */
export const LoadError: Story = {
  name: "Error",
  args: { summary: null, error: "Could not reach the memory service (HTTP 503)." }
}
