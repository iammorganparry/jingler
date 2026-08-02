import type { Meta, StoryObj } from "@storybook/react-vite"
import { MemoryAnalytics } from "./memory-analytics.js"
import { memoryDashboardSummary, memoryDashboardSummaryLarge } from "./memory.mock.js"

/**
 * The accessible, text-first analytics table — every dashboard trend restated as
 * a labelled row so it reads without colour or motion.
 */
const meta: Meta<typeof MemoryAnalytics> = {
  title: "Composites/Memory/Analytics",
  component: MemoryAnalytics,
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
type Story = StoryObj<typeof MemoryAnalytics>

export const Populated: Story = {
  args: { summary: memoryDashboardSummary }
}

export const LargeVault: Story = {
  args: { summary: memoryDashboardSummaryLarge }
}

/** No summary available — the fallback copy. */
export const Unavailable: Story = {
  args: { summary: null }
}
