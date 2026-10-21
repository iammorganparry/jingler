import type { Meta, StoryObj } from "@storybook/react-vite"
import { SubagentScopeBar } from "./subagent-scope-bar.js"

const meta = {
  title: "App/SubagentScopeBar",
  component: SubagentScopeBar,
  args: { agent: "reviewer", branch: "feat/review-retry", prNumber: 491, onShowAll: () => {} }
} satisfies Meta<typeof SubagentScopeBar>

export default meta
type Story = StoryObj<typeof meta>

export const WithPr: Story = {}
export const NoPr: Story = { args: { prNumber: null } }
