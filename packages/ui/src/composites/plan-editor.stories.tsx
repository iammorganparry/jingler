import { useState } from "react"
import type { PlanDocument } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanEditor } from "./plan-editor.js"

/**
 * The integrated plan workspace: a segmented switcher over three read-only pages
 * — **Steps** (compact checklist), **Guide** (rationale, call paths, architecture),
 * **Workflow** (react-flow DAG with per-node Stop/Retry) — plus
 * the floating approve/resume actions.
 */
const meta: Meta = { title: "Composites/Plan Editor (three pages)" }
export default meta
type Story = StoryObj

const document: PlanDocument = {
  id: "plan-frame",
  sessionId: "s1",
  producingChatId: "c1",
  revision: 3,
  status: "proposed",
  plan: {
    title: "PRD: Agent-authored plan view",
    sections: [],
    stages: [
      {
        id: "s_01",
        title: "Frame the editor",
        intent: "Render the plan read-only.",
        approach: ["Wire PlanEditor to the projection"],
        files: [{ path: "packages/ui/src/composites/plan-editor.tsx", change: "M" }],
        diagrams: [],
        notes: [],
        walkthrough: [
          { kind: "prose", id: "s_01-why", text: "Keep plan rendering separate from revision writes." },
          { kind: "code", id: "s_01-code", language: "tsx", code: "<PlanEditor document={document} />" }
        ],
        acceptance: [{ id: "s_01.1", text: "The outline renders.", status: "pending", evidence: null }]
      }
    ],
    annotations: []
  },
  updatedAt: "2026-08-02T00:00:00.000Z",
  updatedBy: "agent"
}

function Harness({ transient }: { transient?: boolean }) {
  const [log, setLog] = useState<string | null>(null)
  return (
    <div className="flex h-[760px] w-[980px] flex-col overflow-hidden rounded-lg border border-hairline">
      <PlanEditor
        document={document}
        source={JSON.stringify(document.plan)}
        state="clean"
        transientState={transient ? "composing" : undefined}
        canApprove
        onApprove={() => setLog("approve")}
        onResume={() => setLog("resume")}
        onRevise={() => setLog("revise")}
        onStopWorker={(id) => setLog(`stop ${id}`)}
        onRetryWorker={(id) => setLog(`retry ${id}`)}
      />
      {log && (
        <div className="flex-none border-t border-hairline bg-panel px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          {log}
        </div>
      )}
    </div>
  )
}

/** Canonical plan across all three pages. Switch tabs; try Stop/Retry on Workflow. */
export const FourPages: Story = { render: () => <Harness /> }

/** Still composing: Steps falls back to the read-only document as the plan streams in. */
export const Streaming: Story = { render: () => <Harness transient /> }
