import { useState } from "react"
import type { PlanDocument } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanEditor } from "./plan-editor.js"

/**
 * The integrated plan workspace: a segmented switcher over three read-only pages
 * — **Main** (step outline), **Architecture** (prose + mermaid), **Workflow**
 * (react-flow DAG with per-node Stop/Retry) — plus the floating approve/resume
 * actions. Flip the tabs at the top and click a Workflow node to jump to Main.
 */
const meta: Meta = { title: "Composites/Plan Editor (three pages)" }
export default meta
type Story = StoryObj

const SOURCE = `<h1>PRD: Agent-authored plan view</h1>
<h2>Context</h2>
<p>Replace the TipTap editor with a read-only, agent-controlled plan presented across three pages.</p>
<h2>Goals</h2>
<ul><li>Drop the WYSIWYG editor entirely.</li><li>Keep commenting on plan items.</li></ul>
<h2>Technical design</h2>
<p>HTML stays the source of truth; a derived projection feeds the step outline, the architecture page and the workflow DAG.</p>
<div data-diagram="mermaid"><pre>graph TD; A[HTML source] --> B[PlanPrd projection]; B --> C[Main outline]; B --> D[Architecture]; B --> E[Workflow DAG];</pre></div>
<section data-stage="01" data-title="Read model" data-depends-on="" data-complexity="low" data-execution-status="completed">
<h3>Intent</h3><p>Pure selectors derived from <code>PlanPrd</code>.</p>
<ul data-files><li data-change="A" data-added="206" data-removed="0">packages/core/src/plan-view.ts</li></ul>
<div data-acceptance="01.1" data-status="passed" data-evidence="13 tests green">Selectors split PlanPrd into three views.</div>
</section>
<section data-stage="02" data-title="Drop TipTap for a read-only renderer" data-depends-on="01" data-complexity="high">
<div data-assignment data-agent-id="worker-02" data-cli="codex" data-model="gpt-5.6-sol" data-reason="High complexity route." data-status="running"></div>
<h3>Intent</h3><p>Render the agent's sanitized HTML read-only; remove the WYSIWYG editor.</p>
<ul data-files><li data-change="A" data-added="240" data-removed="0">packages/ui/src/composites/plan-doc/plan-doc-view.tsx</li><li data-change="D" data-added="0" data-removed="812">packages/ui/src/composites/plan-doc/plan-doc-editor.tsx</li></ul>
<div data-acceptance="02.1" data-status="pending">No @tiptap import remains.</div>
</section>
<section data-stage="03" data-title="Workflow DAG page" data-depends-on="" data-complexity="medium">
<div data-assignment data-agent-id="worker-03" data-cli="claude" data-model="opus" data-reason="Canvas work." data-status="failed"></div>
<h3>Intent</h3><p>react-flow dependency graph coloured by execution status.</p>
<ul data-files><li data-change="A" data-added="207" data-removed="0">packages/ui/src/composites/plan-workflow.tsx</li></ul>
<div data-acceptance="03.1" data-status="failed" data-evidence="node colours undefined">Nodes coloured by execution status.</div>
</section>
<h2>Testing</h2>
<p>pnpm typecheck, pnpm test, pnpm lint.</p>`

const document: PlanDocument = {
  id: "plan-frame",
  sessionId: "s1",
  producingChatId: "c1",
  revision: 3,
  status: "proposed",
  source: SOURCE,
  // PlanEditor derives the live projection from `source`; the document's own
  // projection only feeds status/floating actions, so a minimal shell is fine.
  projection: { title: "PRD: Agent-authored plan view", sections: [], stages: [], annotations: [] },
  updatedAt: "2026-08-02T00:00:00.000Z",
  updatedBy: "agent"
}

function Harness({ transient }: { transient?: boolean }) {
  const [log, setLog] = useState<string | null>(null)
  return (
    <div className="flex h-[760px] w-[980px] flex-col overflow-hidden rounded-lg border border-hairline">
      <PlanEditor
        document={document}
        source={SOURCE}
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
export const ThreePages: Story = { render: () => <Harness /> }

/** Still composing: Main falls back to the read-only document as the plan streams in. */
export const Streaming: Story = { render: () => <Harness transient /> }
