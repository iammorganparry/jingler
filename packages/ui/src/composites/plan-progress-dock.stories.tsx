import type { PlanDocument, PlanPrdStage } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanProgressDock } from "./plan-progress-dock.js"

const stage = (
  id: string,
  title: string,
  executionStatus: PlanPrdStage["executionStatus"],
  acceptanceStatus: PlanPrdStage["acceptance"][number]["status"] = "pending",
  assignment: NonNullable<PlanPrdStage["assignment"]> = {
    agentId: "worker-core",
    cli: "codex",
    model: "gpt-5.6-sol",
    reason: "Assigned by the approved plan."
  }
): PlanPrdStage => ({
  id,
  title,
  intent: title,
  approach: [],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [
    {
      id: `${id}.1`,
      text: `${title} is verified.`,
      status: acceptanceStatus,
      evidence: acceptanceStatus === "passed" ? "Verified." : null
    }
  ],
  assignment,
  executionStatus
})

const documentWith = (
  stages: ReadonlyArray<PlanPrdStage>,
  status: PlanDocument["status"] = "executing"
): PlanDocument => ({
  id: "plan-progress-story",
  sessionId: "session-story",
  producingChatId: "chat-story",
  revision: 8,
  status,
  plan: {
    title: "PRD: Composer progress",
    sections: [],
    stages,
    annotations: []
  },
  updatedAt: "2026-07-30T09:00:00.000Z",
  updatedBy: "agent"
})

const activeDocument = documentWith([
  stage("01", "Persist orchestrator settings", "completed", "passed"),
  stage("02", "Build execution graph", "completed", "passed"),
  stage("03", "Run independent workers", "running", "pending", {
    agentId: "worker-execution",
    cli: "claude",
    model: "claude-opus-4-1",
    reason: "High-complexity execution route."
  }),
  stage("04", "Reconcile amendments", "queued", "pending", {
    agentId: "worker-execution",
    cli: "claude",
    model: "claude-opus-4-1",
    reason: "Shares dependencies with execution."
  }),
  stage("05", "Verify the workflow", "queued", "pending", {
    agentId: "worker-release",
    cli: "opencode",
    model: "anthropic/claude-sonnet-4",
    reason: "Independent verification route."
  })
])

const meta = {
  title: "Plan/Plan Progress Dock",
  component: PlanProgressDock,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[560px] rounded-2xl bg-editor p-4">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof PlanProgressDock>

export default meta
type Story = StoryObj<typeof meta>

/** Click the summary to inspect every stage, then click a row to open that stage. */
export const Running: Story = {
  args: {
    document: activeDocument,
    onOpenStage: (stageId) => console.info("Open plan stage", stageId)
  }
}

export const NeedsAttention: Story = {
  args: {
    document: documentWith([
      stage("01", "Resolve provider catalogue", "completed", "passed"),
      stage("02", "Execute worker group", "blocked"),
      stage("03", "Retry verification", "failed"),
      stage("04", "Resume after restart", "interrupted"),
      stage("05", "Settle the plan", "queued")
    ])
  }
}

export const Complete: Story = {
  args: {
    document: documentWith(
      [
        stage("01", "Assign workers", "completed", "passed"),
        stage("02", "Execute stages", "completed", "passed"),
        stage("03", "Verify evidence", "completed", "passed")
      ],
      "done"
    )
  }
}
