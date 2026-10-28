import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Usage } from "@jingler/core"
import { makeUsageFact, usageReportFromFacts } from "@jingler/core"
import { UsageModal } from "./usage-modal.js"

const meta = {
  title: "Composites/UsageModal",
  component: UsageModal,
  parameters: { layout: "fullscreen" }
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

/** Enterprise / API-priced login: spend rows, no percentage bars. */
export const ApiPricing: Story = {
  args: {
    open: true,
    usage: {
      fetchedAt: "2026-10-13T12:00:00.000Z",
      providers: [{
        name: "Claude",
        plan: "Enterprise · API pricing",
        available: true,
        billingRoute: "api",
        windows: [],
        spend: {
          lastSession: { tokens: 12_500, costUsd: 1.23 },
          today: { tokens: 480_000, costUsd: 4.5 },
          month: { tokens: 9_200_000, costUsd: 61.07 }
        }
      }]
    } as unknown as Usage
  }
}
