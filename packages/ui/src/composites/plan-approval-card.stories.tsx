import type { Plan, PlanDocument } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanApprovalCard } from "./plan-card.js"

const plan = (status: Plan["status"] = "proposed"): Plan => ({
  id: "approval-card-plan",
  summary: "Refresh the plan chat experience",
  status,
  structured: true,
  raw: "Apply the AI CSS approval, task-list, and streaming patterns with Jingler theme tokens.",
  comments: [],
  steps: [
    ["01", "Build the plan approval card"],
    ["02", "Embed task status in the composer"],
    ["03", "Add streaming text treatment"],
    ["04", "Verify the Storybook flow"]
  ].map(([number, title]) => ({
    id: `step-${number}`,
    number: number!,
    title: title!,
    intent: title!,
    approach: [],
    kind: "step" as const,
    condition: null,
    parentId: null,
    dependsOn: [],
    blocks: [],
    files: [],
    guards: [],
    code: null,
    diff: null,
    status: "proposed" as const,
    flagged: false
  }))
})

const documentFor = (value: Plan): PlanDocument => ({
  id: value.id,
  sessionId: "session-story",
  producingChatId: "chat-story",
  revision: 1,
  status: value.status === "approved" ? "approved" : value.status,
  plan: {
    title: value.summary,
    sections: [{
      id: "overview",
      title: "Overview",
      blocks: [{
        kind: "prose",
        id: "overview-copy",
        text: "Apply the AI CSS approval, task-list, and streaming patterns with Jingler theme tokens."
      }]
    }],
    stages: value.steps.map((step, index) => ({
      id: step.id,
      title: step.title,
      intent: step.intent,
      approach: [],
      tasks: [
        { id: `${step.id}-a`, text: `Implement ${step.title.toLowerCase()}`, status: index === 0 ? "in-progress" : "pending" },
        { id: `${step.id}-b`, text: `Verify ${step.title.toLowerCase()}`, status: "pending" }
      ],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: []
    })),
    annotations: []
  },
  updatedAt: "2026-08-01T00:00:00.000Z",
  updatedBy: "agent"
})

const meta = {
  title: "Plan/Approval Card",
  component: PlanApprovalCard,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-[620px] bg-editor p-5"><Story /></div>]
} satisfies Meta<typeof PlanApprovalCard>
export default meta
type Story = StoryObj<typeof meta>

export const AwaitingApproval: Story = {
  args: { plan: plan(), document: documentFor(plan()), onOpenReview: () => {} }
}

export const Revising: Story = {
  args: { plan: plan("revising"), document: documentFor(plan("revising")), onOpenReview: () => {} }
}

export const Approved: Story = {
  args: { plan: plan("approved"), document: documentFor(plan("approved")), onOpenReview: () => {} }
}
