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

export const WorkflowFleetTree: Story = {
  args: {
    subagents: [
      { id: "orch", agent: "orchestrator", task: "Ship the redesign", status: "running", startedAt: now - 400_000 },
      { id: "w1", parentId: "orch", agent: "worker", task: "Implement the tree", status: "running", startedAt: now - 300_000 },
      { id: "r1", parentId: "w1", agent: "reviewer", task: "Review the diff", status: "spawning", startedAt: now - 3_000 },
      { id: "w2", parentId: "orch", agent: "worker", task: "Run e2e", status: "failed", startedAt: now - 200_000, endedAt: now - 150_000 },
      { id: "s1", parentId: "orch", agent: "scout", task: "Map the lane header", status: "completed", startedAt: now - 300_000, endedAt: now - 120_000 }
    ]
  }
}

export const WorkspaceDetail: Story = {
  args: {
    subagents: [
      { id: "a", agent: "reviewer", task: "Review the diff", status: "running", startedAt: now - 95_000, branch: "feat/review-retry", diff: { added: 42, removed: 8 }, prNumber: 491 },
      { id: "b", agent: "worker", task: "Implement the chip popover", status: "running", startedAt: now - 60_000, branch: "feat/redesign-8.11-subagent-row-and-meta-strip-with-a-long-name", diff: { added: 1204, removed: 388 }, prNumber: 4912 },
      { id: "c", agent: "scout", task: "Map the lane header", status: "completed", startedAt: now - 300_000, endedAt: now - 120_000, branch: null }
    ]
  }
}
