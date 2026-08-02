import { useState } from "react"
import type {
  PlanPrd,
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageComplexity,
  PlanStageExecutionStatus
} from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanWorkflow } from "./plan-workflow.js"

const meta: Meta = { title: "Composites/Plan Workflow" }
export default meta
type Story = StoryObj

const worker = (
  agentId: string,
  cli: PlanStageAssignment["cli"],
  model: string
): PlanStageAssignment => ({ agentId, cli, model, reason: "Routed by complexity." })

const stage = (
  id: string,
  title: string,
  executionStatus: PlanStageExecutionStatus,
  dependencies: ReadonlyArray<string> = [],
  complexity: PlanStageComplexity | undefined = "medium",
  assignment: PlanStageAssignment | null = null
): PlanPrdStage => ({
  id,
  title,
  intent: title,
  markdown: "",
  acceptance: [],
  dependencies,
  complexity,
  executionStatus,
  assignment
})

const prdWith = (stages: ReadonlyArray<PlanPrdStage>): PlanPrd => ({
  title: "PRD: Plan workflow",
  sections: [],
  stages,
  annotations: []
})

/**
 * A branching, multi-stage plan mid-execution: a completed root fans out into
 * parallel work, one lane already failed, another is running, a downstream stage
 * is blocked on it, and the tail is still queued — every execution status on one
 * canvas. Click a node to drive selection.
 */
const branchingPrd = prdWith([
  stage("01", "Scaffold contract types", "completed", [], "low"),
  stage("02", "Build execution graph", "completed", ["01"], "medium"),
  stage("03", "Wire the orchestrator", "running", ["02"], "high", worker("agent-03", "codex", "gpt-5.6-sol")),
  stage("04", "Add worker routing", "failed", ["02"], "high", worker("agent-04", "claude", "opus")),
  stage("05", "Persist progress state", "blocked", ["04"], "medium", worker("agent-05", "codex", "gpt-5.6-sol")),
  stage("06", "Render the workflow page", "interrupted", ["03"], "medium", worker("agent-06", "cursor", "auto")),
  stage("07", "Ship the nav shell", "queued", ["05", "06"], "low")
])

const singleStagePrd = prdWith([
  stage("01", "Add rate limiting to the refund route", "running", [], "high", worker("agent-01", "codex", "gpt-5.6-sol"))
])

function Harness({ prd }: { prd: PlanPrd }) {
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  return (
    <div className="flex h-[560px] w-[840px] flex-col overflow-hidden rounded-lg border border-hairline">
      <PlanWorkflow
        prd={prd}
        selectedStageId={selectedStageId}
        onSelectStage={setSelectedStageId}
        onStopWorker={(agentId) => setLog(`stop ${agentId}`)}
        onRetryWorker={(agentId) => setLog(`retry ${agentId}`)}
      />
      {log && (
        <div className="flex-none border-t border-hairline bg-panel px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          {log}
        </div>
      )}
    </div>
  )
}

export const Branching: Story = {
  render: () => <Harness prd={branchingPrd} />
}

export const SingleStage: Story = {
  render: () => <Harness prd={singleStagePrd} />
}
