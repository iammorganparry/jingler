import { useState } from "react"
import type { PlanPrd, PlanPrdStage, PlanTaskStatus } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanWorkflow } from "./plan-workflow.js"

const meta: Meta = { title: "Composites/Plan Workflow" }
export default meta
type Story = StoryObj

const stage = (id: string, title: string, status: PlanTaskStatus, dependencies: ReadonlyArray<string> = []): PlanPrdStage => ({
  id,
  title,
  intent: title,
  approach: [],
  tasks: [{ id: `${id}.task`, text: title, status }],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [],
  dependencies,
  complexity: "medium"
})
const prd: PlanPrd = {
  title: "PRD: Workspace flow",
  sections: [],
  stages: [
    stage("01", "Register project", "completed"),
    stage("02", "Create workspace", "in-progress", ["01"]),
    stage("03", "Open conversation", "pending", ["02"])
  ],
  annotations: []
}

function Harness() {
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  return <div className="h-[560px] w-[840px] overflow-hidden rounded-lg border border-hairline"><PlanWorkflow prd={prd} selectedStageId={selectedStageId} onSelectStage={setSelectedStageId} /></div>
}
export const Branching: Story = { render: () => <Harness /> }
