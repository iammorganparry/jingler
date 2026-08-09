import type { PlanDocument, PlanPrdStage, PlanTaskStatus } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanProgressDock } from "./plan-progress-dock.js"

const stage = (id: string, title: string, status: PlanTaskStatus, passed = false): PlanPrdStage => ({
  id,
  title,
  intent: title,
  approach: [],
  tasks: [{ id: `${id}.task`, text: title, status }],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [{ id: `${id}.1`, text: `${title} is verified.`, testReferences: [], status: passed ? "passed" : "pending", evidence: passed ? "Verified." : null }]
})

const document: PlanDocument = {
  id: "plan-progress-story",
  sessionId: "session-story",
  producingChatId: "chat-story",
  revision: 8,
  status: "executing",
  plan: {
    title: "PRD: Single-agent progress",
    sections: [],
    stages: [
      stage("01", "Register projects", "completed", true),
      stage("02", "Build workspace creation", "in-progress"),
      stage("03", "Verify the workflow", "pending")
    ],
    annotations: []
  },
  updatedAt: "2026-07-30T09:00:00.000Z",
  updatedBy: "agent"
}

const meta = {
  title: "Plan/Plan Progress Dock",
  component: PlanProgressDock,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-[560px] rounded-2xl bg-editor p-4"><Story /></div>]
} satisfies Meta<typeof PlanProgressDock>
export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = { args: { document } }
