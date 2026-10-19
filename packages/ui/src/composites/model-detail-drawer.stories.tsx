import type { Meta, StoryObj } from "@storybook/react-vite"
import { makeUsageFact, modelDetailFromFacts } from "@jingler/core"
import { ModelDetailDrawer } from "./model-detail-drawer.js"

const meta = {
  title: "Composites/ModelDetailDrawer",
  component: ModelDetailDrawer
} satisfies Meta<typeof ModelDetailDrawer>

export default meta
type Story = StoryObj<typeof meta>

const facts = [100, 400, 220, 900, 150].map((durationMs, i) =>
  makeUsageFact({
    id: `run-${i}`,
    runId: `run-${i}`,
    sessionId: "s",
    chatId: "c",
    parentRunId: null,
    runtimeId: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet",
    kind: "parent",
    startedAt: Date.now() + i * 1000,
    durationMs,
    outcome: "success",
    provenance: "story",
    inputTokens: 300,
    outputTokens: 100,
    totalTokens: 400,
    costUsd: 0.1,
    toolCalls: 2
  })
)

const detail = modelDetailFromFacts(facts, {
  runtimeId: "claude",
  providerId: "anthropic",
  modelId: "claude-sonnet",
  kind: "parent"
})

/** Per-model drill-down from a model performance table row (#503). */
export const Open: Story = {
  args: { open: true, detail, onOpenChange: () => {} }
}
