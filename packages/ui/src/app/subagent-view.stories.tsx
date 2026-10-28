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
