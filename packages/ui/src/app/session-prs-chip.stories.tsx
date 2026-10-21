import type { Meta, StoryObj } from "@storybook/react-vite"
import { SessionPrsChip } from "./session-prs-chip.js"

const meta = {
  title: "App/SessionPrsChip",
  component: SessionPrsChip,
  args: { onSelect: () => {} }
} satisfies Meta<typeof SessionPrsChip>

export default meta
type Story = StoryObj<typeof meta>

export const MainAndChild: Story = {
  args: {
    rows: [
      { number: 482, agent: "main", branch: null },
      { number: 491, agent: "reviewer", branch: "fix/491", state: "running", nodeId: "n1" }
    ]
  }
}

export const MainAndTwoChildren: Story = {
  args: {
    rows: [
      { number: 482, agent: "main", branch: null },
      { number: 491, agent: "reviewer", branch: "fix/491", state: "running", nodeId: "n1" },
      { number: 493, agent: "worker", branch: "feat/child-worktree-change", state: "completed", nodeId: "n2" }
    ]
  }
}
