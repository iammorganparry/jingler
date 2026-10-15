import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ProviderId, SubagentFleetNode } from "@jingler/core"
import { SubagentMetaStrip } from "./subagent-meta-strip.js"

const node: SubagentFleetNode = {
  id: "parent/run-1",
  subagentId: "run-1",
  orchestrationRunId: "run-1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "run-1",
  parentId: null,
  parentRuntimeSessionId: "parent",
  agent: "scout",
  task: "Map the UI",
  model: "claude-sonnet-5-5",
  status: "running",
  health: "connected",
  phase: "scanning",
  blocking: null,
  terminal: null,
  background: true,
  sessionFile: null,
  currentTool: "workspace_read_file",
  startedAt: Date.now() - 135_000,
  updatedAt: Date.now(),
  completedAt: null,
  usage: { inputTokens: 12_400, outputTokens: 900, totalTokens: 13_300, costUsd: 0.42, durationMs: 10_000, toolCalls: 7 },
  artifacts: [{ kind: "report", path: "/tmp/out/report.md", label: "report.md" }],
  attention: null,
  workspace: null,
  prNumber: null
}

const meta = {
  title: "App/SubagentMetaStrip",
  component: SubagentMetaStrip,
  args: { node, providerId: "anthropic" as ProviderId },
  decorators: [(Story) => <div style={{ width: 360 }}><Story /></div>]
} satisfies Meta<typeof SubagentMetaStrip>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {}
export const SparseNode: Story = {
  args: {
    node: { ...node, model: null, currentTool: null, background: false, artifacts: [], usage: { ...node.usage, costUsd: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 } }
  }
}
export const Failed: Story = { args: { node: { ...node, status: "failed", currentTool: null, completedAt: Date.now() } } }
export const Worktree: Story = {
  args: {
    node: { ...node, workspace: { path: "/wt/reviewer", branch: "feat/review-retry", baseRef: "main", diff: { added: 42, removed: 8 } }, prNumber: 491 }
  }
}
export const LongBranch: Story = {
  args: {
    node: { ...node, workspace: { path: "/wt/r", branch: "feat/redesign-8.11-subagent-row-and-meta-strip-with-a-very-long-name", baseRef: null, diff: { added: 1204, removed: 388 } }, prNumber: 4912 }
  }
}
