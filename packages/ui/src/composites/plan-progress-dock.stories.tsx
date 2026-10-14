import type { PlanDocument, PlanPrdStage, PlanTaskStatus } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanProgressRow, PlanTaskList, type PlanProgressStatus } from "./plan-progress-dock.js"

const stage = (id: string, title: string, status: PlanTaskStatus, passed = false, failed = false): PlanPrdStage => ({
  id,
  title,
  intent: title,
  approach: [],
  tasks: [{ id: `${id}.task`, text: title, status }],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [{ id: `${id}.1`, text: `${title} is verified.`, testReferences: [], status: failed ? "failed" : passed ? "passed" : "pending", evidence: passed ? "Verified." : null }]
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
  title: "Plan/Task List",
  component: PlanTaskList,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-[560px] rounded-2xl bg-editor p-4"><Story /></div>]
} satisfies Meta<typeof PlanTaskList>
export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = { args: { document } }

const withStages = (stages: PlanDocument["plan"]["stages"]): PlanDocument => ({ ...document, plan: { ...document.plan, stages } })

export const Failed: Story = {
  args: {
    document: withStages([
      stage("01", "Register projects", "completed", true),
      stage("02", "Build workspace creation", "pending", false, true),
      stage("03", "Verify the workflow", "pending")
    ]),
    onStageAction: () => {}
  }
}

export const Blocked: Story = {
  args: {
    document: withStages([
      stage("01", "Register projects", "completed", true),
      stage("02", "Build workspace creation", "blocked"),
      stage("03", "Verify the workflow", "pending")
    ]),
    onStageAction: () => {}
  }
}

const ALL_STATUSES: ReadonlyArray<PlanProgressStatus> = ["todo", "in-progress", "done", "blocked", "failed", "interrupted"]

/** Every PlanProgressStatus, including `interrupted`, which no stage projection produces yet. */
export const AllStatuses: Story = {
  args: { document },
  render: () => (
    <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
      {ALL_STATUSES.map((status, index) => (
        <li key={status}>
          <PlanProgressRow status={status} step={index + 1} stage={{ id: status, title: `Step ${index + 1} · ${status}` }} onStageAction={() => {}} />
        </li>
      ))}
    </ol>
  )
}
