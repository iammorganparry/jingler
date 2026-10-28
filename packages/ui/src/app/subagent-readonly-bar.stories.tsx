import type { Meta, StoryObj } from "@storybook/react-vite"
import type { SubagentFleetNode } from "@jingler/core"
import { SubagentReadOnlyBar } from "./subagent-readonly-bar.js"

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
  title: "App/SubagentReadOnlyBar",
  component: SubagentReadOnlyBar,
  args: {
    node,
    mainTitle: "Survey the app",
    onStop: () => new Promise(() => {}),
    onReply: () => {},
    onRetry: () => {}
  },
  decorators: [(Story) => <div style={{ width: 360 }}><Story /></div>]
} satisfies Meta<typeof SubagentReadOnlyBar>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {}
export const NeedsReply: Story = {
  args: {
    node: {
      ...node,
      status: "needs-attention",
      attention: { requestId: "r1", reason: "need_decision", message: "Should I include accessibility behavior?", requestedAt: 1, deadlineAt: null }
    }
  }
}
export const Failed: Story = {
  args: { node: { ...node, status: "failed", terminal: { reason: "failed", summary: "Build failed: 3 type errors", at: 90_000, retryable: true } } }
}
export const Stopped: Story = {
  args: { node: { ...node, status: "stopped", terminal: { reason: "stopped", summary: "Stopped", at: 130_000, retryable: false } } }
}
