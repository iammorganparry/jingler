import type { Meta, StoryObj } from "@storybook/react-vite"
import { makeUsageFact, usageReportFromFacts } from "@jingler/core"
import { UsageModal } from "./usage-modal.js"

const meta = {
  title: "Composites/UsageModal",
  component: UsageModal
} satisfies Meta<typeof UsageModal>

export default meta
type Story = StoryObj<typeof meta>

const report = usageReportFromFacts([
  makeUsageFact({
    id: "a", runId: "a", sessionId: "s", chatId: "c", parentRunId: null,
    runtimeId: "claude", providerId: "anthropic", modelId: "claude-sonnet", kind: "parent",
    startedAt: Date.now(), outcome: "success", provenance: "story",
    inputTokens: 1200, outputTokens: 400, totalTokens: 1600, costUsd: 0.48, toolCalls: 3
  }),
  makeUsageFact({
    id: "b", runId: "b", sessionId: "s", chatId: "c", parentRunId: null,
    runtimeId: "codex", providerId: "openai", modelId: "gpt-codex", kind: "parent",
    startedAt: Date.now(), outcome: "success", provenance: "story",
    inputTokens: 300, outputTokens: 90, totalTokens: 390, toolCalls: 1
  })
])

/** Execution report with the runtime filter, KPI strip and sortable model table (board 18b). */
export const ExecutionReport: Story = {
  args: { open: true, usage: null, report }
}

export const Loading: Story = { args: { open: true, usage: null, loading: true } }
