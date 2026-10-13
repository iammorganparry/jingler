import type { Meta, StoryObj } from "@storybook/react-vite"
import { SubagentChip } from "./subagent-chip.js"

const now = Date.now()

const meta = {
  title: "App/SubagentChip",
  component: SubagentChip,
  args: { onOpenSubagent: () => {} }
} satisfies Meta<typeof SubagentChip>

export default meta
type Story = StoryObj<typeof meta>

export const RunningAndFinished: Story = {
  args: {
    subagents: [
      { id: "a", agent: "worker", task: "Implement the chip popover", status: "running", startedAt: now - 95_000 },
      { id: "b", agent: "reviewer", task: "Review the diff", status: "spawning", startedAt: now - 3_000 },
      { id: "c", agent: "scout", task: "Map the lane header", status: "completed", startedAt: now - 300_000, endedAt: now - 120_000 },
      { id: "d", agent: "worker", task: "Run e2e", status: "failed", startedAt: now - 200_000, endedAt: now - 150_000 }
    ]
  }
}

export const AllFinished: Story = {
  args: {
    subagents: [{ id: "c", agent: "scout", task: "Map the lane header", status: "completed", startedAt: now - 300_000, endedAt: now - 120_000 }]
  }
}

export const None: Story = { args: { subagents: [] } }
