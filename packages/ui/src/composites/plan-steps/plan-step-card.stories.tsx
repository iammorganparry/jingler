import { useState } from "react"
import type { PlanStepView } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanStepCard } from "./plan-step-card.js"

/**
 * A single `PlanStepCard` in isolation — the Main-page unit. Header (id + title +
 * complexity + execution status) over three sections: Changes, Tasks, Tests.
 */
const meta: Meta = { title: "Composites/Plan Step Card" }
export default meta
type Story = StoryObj

const step = (over: Partial<PlanStepView> & Pick<PlanStepView, "id" | "title">): PlanStepView => ({
  intent: "",
  complexity: "medium",
  executionStatus: "queued",
  acceptance: [],
  files: [],
  markdown: "",
  ...over
})

const running = step({
  id: "02",
  title: "Drop TipTap for a read-only renderer",
  intent: "Render the agent's sanitized HTML read-only; remove the WYSIWYG editor.",
  complexity: "high",
  executionStatus: "running",
  markdown: "<p>Delete the <code>plan-doc/</code> TipTap surface and re-render from the projection.</p>",
  files: [
    { path: "packages/ui/src/composites/plan-doc/plan-doc-view.tsx", change: "A", added: 240, removed: 0 },
    { path: "packages/ui/src/composites/plan-doc/plan-doc-editor.tsx", change: "D", added: 0, removed: 812 }
  ],
  acceptance: [
    { id: "02.1", text: "No @tiptap import remains in the repo.", status: "passed", evidence: "grep clean" },
    { id: "02.2", text: "Plan renders agent HTML read-only.", status: "pending", evidence: null }
  ]
})

const failed = step({
  id: "04",
  title: "Add worker routing by CLI kind",
  intent: "Route each stage to the CLI the planner assigned.",
  complexity: "high",
  executionStatus: "failed",
  files: [{ path: "packages/cli-adapters/src/routing.ts", change: "A", added: 96, removed: 0 }],
  acceptance: [
    { id: "04.1", text: "Unassigned stages use the session default.", status: "failed", evidence: "throws when default unset" },
    { id: "04.2", text: "Unknown CLI kinds are rejected.", status: "waived", evidence: null }
  ]
})

const empty = step({ id: "07", title: "Ship the nav shell", complexity: "low", executionStatus: "queued" })

const manyFiles = step({
  id: "05",
  title: "Sweeping refactor across the renderer",
  intent: "Rename the RPC client method everywhere it is called.",
  complexity: "high",
  executionStatus: "running",
  files: Array.from({ length: 240 }, (_, i) => ({
    path: `apps/desktop/src/renderer/module-${String(i + 1).padStart(3, "0")}.ts`,
    change: "M" as const,
    added: (i % 7) + 1,
    removed: i % 3
  }))
})

function Harness({ steps }: { steps: ReadonlyArray<PlanStepView> }) {
  const [selected, setSelected] = useState<string | null>(steps[0]?.id ?? null)
  return (
    <div className="flex w-[520px] flex-col gap-2.5 bg-editor p-4">
      {steps.map((s) => (
        <PlanStepCard key={s.id} step={s} active={s.id === selected} onSelect={setSelected} />
      ))}
    </div>
  )
}

export const Running: Story = { render: () => <Harness steps={[running]} /> }
export const Failed: Story = { render: () => <Harness steps={[failed]} /> }
export const Mixed: Story = { render: () => <Harness steps={[running, failed, empty]} /> }
/** 240 changed files: chips cap at 12 and collapse the rest into "+N more". */
export const ManyFiles: Story = { render: () => <Harness steps={[manyFiles]} /> }
