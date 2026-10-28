import type { Meta, StoryObj } from "@storybook/react-vite"
import type { SubagentFleetNode } from "@jingler/core"
import { FleetAgentView } from "./subagent-view.js"

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
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: false,
  sessionFile: null,
  currentTool: null,
  startedAt: 0,
  updatedAt: 0,
  completedAt: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
  artifacts: [],
  attention: null,
  workspace: null,
  prNumber: null
}

const meta = {
  title: "App/SubagentView",
  component: FleetAgentView,
  args: { node, messages: [], onRetry: () => {} },
  decorators: [(Story) => <div style={{ display: "flex", height: 520, width: 760 }}><Story /></div>]
} satisfies Meta<typeof FleetAgentView>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = { args: { loading: true } }
export const Orchestrator: Story = { args: { node: { ...node, nodeKind: "workflow", agent: "workflow" } } }
export const LoadError: Story = { args: { error: "Could not load the child transcript." } }
export const NeedsAttention: Story = {
  args: {
    node: {
      ...node,
      status: "needs-attention",
      attention: {
        requestId: "request-1",
        reason: "need_decision",
        message: "Should the retry use exponential backoff?",
        requestedAt: 0,
        deadlineAt: null
      }
    }
  }
}

const running: SubagentFleetNode = {
  ...node,
  model: "claude-sonnet-5-5",
  phase: "scanning",
  currentTool: "workspace_read_file",
  background: true,
  task: "Map the UI components and report which ones still use raw buttons, with file paths and a suggested fix for each.",
  usage: { inputTokens: 12_400, outputTokens: 900, totalTokens: 13_300, costUsd: 0.42, durationMs: 10_000, toolCalls: 7 }
}
const finished = { ...running, currentTool: null, phase: null, completedAt: 60_000 }

export const Running: Story = { args: { node: running } }
export const DoneWithOutput: Story = {
  args: { node: { ...finished, status: "completed", terminal: { reason: "completed", summary: "Found 3 raw buttons in the toolbar.", at: 60_000, retryable: false } } }
}
export const Failed: Story = {
  args: { node: { ...finished, status: "failed", terminal: { reason: "failed", summary: "Tool call timed out.", at: 60_000, retryable: false } } }
}
export const SharedCheckout: Story = { args: { node: running } }
export const Worktree: Story = {
  args: { node: { ...running, workspace: { path: "/wt/scout", branch: "feat/scout-ui-audit", baseRef: "main", diff: { added: 42, removed: 8 } }, prNumber: 491 } }
}
