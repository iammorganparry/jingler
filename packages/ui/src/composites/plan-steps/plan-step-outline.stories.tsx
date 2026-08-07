import { useState } from "react"
import type { PlanAcceptance, PlanPrd, PlanPrdStage } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanStepOutline } from "./plan-step-outline.js"

const meta: Meta = { title: "Composites/Plan Step Outline" }
export default meta
type Story = StoryObj

type FileSpec = { path: string; change: "A" | "M" | "D"; added: number; removed: number }

/** Build the `<ul data-files>` block `toPlanStepViews` parses back into `files`. */
const filesMarkup = (files: ReadonlyArray<FileSpec>): string =>
  files.length === 0
    ? ""
    : `<ul data-files>${files
        .map(
          (f) =>
            `<li data-change="${f.change}" data-added="${f.added}" data-removed="${f.removed}">${f.path}</li>`
        )
        .join("")}</ul>`

const accept = (
  id: string,
  text: string,
  status: PlanAcceptance["status"],
  evidence: string | null = null
): PlanAcceptance => ({ id, text, status, evidence })

const stage = (s: {
  id: string
  title: string
  intent: string
  prose: string
  files: ReadonlyArray<FileSpec>
  acceptance: ReadonlyArray<PlanAcceptance>
  complexity?: PlanPrdStage["complexity"]
  executionStatus?: PlanPrdStage["executionStatus"]
  dependencies?: ReadonlyArray<string>
}): PlanPrdStage => ({
  id: s.id,
  title: s.title,
  intent: s.intent,
  approach: [],
  files: s.files.map((f) => ({ path: f.path, change: f.change, added: f.added, removed: f.removed })),
  diagrams: [],
  notes: s.prose.length > 0 ? [{ kind: "prose", id: `${s.id}-note`, text: s.prose }] : [],
  acceptance: s.acceptance,
  dependencies: s.dependencies ?? [],
  complexity: s.complexity,
  executionStatus: s.executionStatus
})

const prdWith = (stages: ReadonlyArray<PlanPrdStage>): PlanPrd => ({
  title: "PRD: Step outline",
  sections: [],
  stages,
  annotations: []
})

/**
 * A rich, multi-step plan mid-execution: every execution status is represented,
 * acceptance criteria mix passed / failed / pending / waived (some with
 * evidence), and steps carry real file diffs.
 */
const richPrd = prdWith([
  stage({
    id: "01",
    title: "Scaffold the plan-view contract",
    intent: "Add the pure view-model types the three plan surfaces derive from.",
    prose:
      "<p>Introduce <code>PlanStepView</code> and <code>toPlanStepViews</code> as a framework-free projection of the canonical <code>PlanPrd</code>.</p>",
    files: [
      { path: "packages/core/src/plan-view.ts", change: "A", added: 206, removed: 0 },
      { path: "packages/core/src/index.ts", change: "M", added: 1, removed: 0 }
    ],
    acceptance: [
      accept("a1", "toPlanStepViews returns stages in topological order", "passed", "plan-view.test.ts orders by dependency"),
      accept("a2", "Files parse out of the data-files block", "passed", "12 assertions green")
    ],
    complexity: "low",
    executionStatus: "completed"
  }),
  stage({
    id: "02",
    title: "Build the execution graph",
    intent: "Group stages into connected components and order each topologically.",
    prose:
      "<p>Reuse <code>buildPlanExecutionGraph</code> so the outline and the workflow canvas share one ordering.</p>",
    files: [{ path: "packages/core/src/plan-execution.ts", change: "M", added: 64, removed: 8 }],
    acceptance: [accept("b1", "Cycles are broken deterministically", "passed", "source order tie-break")],
    complexity: "medium",
    executionStatus: "completed",
    dependencies: ["01"]
  }),
  stage({
    id: "03",
    title: "Wire the orchestrator to workers",
    intent: "Dispatch each ready stage to a worker and stream progress back.",
    prose:
      "<p>The orchestrator walks the graph, launching stages whose dependencies have completed.</p>",
    files: [
      { path: "packages/cli-adapters/src/orchestration.ts", change: "A", added: 288, removed: 0 },
      { path: "packages/cli-adapters/src/agent-runner.ts", change: "M", added: 41, removed: 12 }
    ],
    acceptance: [
      accept("c1", "A running stage streams status to the renderer", "pending"),
      accept("c2", "Completed stages unblock their dependents", "pending")
    ],
    complexity: "high",
    executionStatus: "running",
    dependencies: ["02"]
  }),
  stage({
    id: "04",
    title: "Add worker routing by CLI kind",
    intent: "Route each stage to the CLI the planner assigned it.",
    prose:
      "<p>Resolve the assignment, fall back to the session default, and surface an error when neither is present.</p>",
    files: [{ path: "packages/cli-adapters/src/routing.ts", change: "A", added: 96, removed: 0 }],
    acceptance: [
      accept("d1", "Unassigned stages use the session default", "failed", "throws when default is unset — needs a guard"),
      accept("d2", "Unknown CLI kinds are rejected", "passed")
    ],
    complexity: "high",
    executionStatus: "failed",
    dependencies: ["02"]
  }),
  stage({
    id: "05",
    title: "Persist progress state",
    intent: "Write durable executionStatus back to the plan document.",
    prose: "<p>Blocked until worker routing lands.</p>",
    files: [{ path: "packages/cli-adapters/src/plan-store.ts", change: "M", added: 30, removed: 4 }],
    acceptance: [accept("e1", "Status survives an app restart", "pending")],
    complexity: "medium",
    executionStatus: "blocked",
    dependencies: ["04"]
  }),
  stage({
    id: "06",
    title: "Render the step outline",
    intent: "Ship the Steps page: one card per step with changes, tasks and tests.",
    prose:
      "<p>Compose existing atoms — <code>FileChip</code>, <code>Badge</code>, <code>StatusDot</code> — into a scannable card.</p>",
    files: [
      { path: "packages/ui/src/composites/plan-steps/plan-step-card.tsx", change: "A", added: 240, removed: 0 },
      { path: "packages/ui/src/composites/plan-steps/plan-step-outline.tsx", change: "A", added: 52, removed: 0 }
    ],
    acceptance: [
      accept("f1", "Empty plans show a 'No steps yet' state", "passed"),
      accept("f2", "Acceptance evidence renders under its criterion", "waived", "covered by the interaction test in Stage 07")
    ],
    complexity: "medium",
    executionStatus: "interrupted",
    dependencies: ["03"]
  }),
  stage({
    id: "07",
    title: "Cross-link Workflow to Steps",
    intent: "Selecting a node on the Workflow page scrolls the matching card into view.",
    prose: "<p>Both surfaces key on the stage id, so selection is a shared string.</p>",
    files: [],
    acceptance: [accept("g1", "Clicking a graph node selects its card", "pending")],
    complexity: "low",
    executionStatus: "queued",
    dependencies: ["05", "06"]
  })
])

const singlePrd = prdWith([
  stage({
    id: "01",
    title: "Add rate limiting to the refund route",
    intent: "Cap refund attempts per customer to blunt card-testing abuse.",
    prose: "<p>Wrap the handler in a sliding-window limiter keyed by customer id.</p>",
    files: [
      { path: "apps/server/src/routes/refund.ts", change: "M", added: 34, removed: 6 },
      { path: "apps/server/src/lib/rate-limit.ts", change: "A", added: 88, removed: 0 }
    ],
    acceptance: [
      accept("a1", "A sixth attempt within a minute is rejected", "passed", "refund.rate-limit.test.ts"),
      accept("a2", "Limits are per-customer, not global", "pending")
    ],
    complexity: "high",
    executionStatus: "running"
  })
])

function Harness({ prd }: { prd: PlanPrd }) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  return (
    <div className="h-[720px] w-[560px] overflow-auto rounded-lg border border-hairline bg-editor">
      <PlanStepOutline prd={prd} selectedStepId={selectedStepId} onSelectStep={setSelectedStepId} />
    </div>
  )
}

export const RichMultiStep: Story = { render: () => <Harness prd={richPrd} /> }
export const SingleStep: Story = { render: () => <Harness prd={singlePrd} /> }
export const Empty: Story = { render: () => <Harness prd={prdWith([])} /> }
