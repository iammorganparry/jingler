import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanDocView } from "./plan-doc-view.js"

/**
 * `PlanDocView` — the read-only renderer of the agent's sanitized plan HTML (the
 * TipTap replacement). It re-sanitizes on every render and renders stages,
 * acceptance criteria, file lists and mermaid diagrams from the plan dialect.
 */
const meta: Meta = { title: "Composites/Plan Doc View (read-only)" }
export default meta
type Story = StoryObj

const SOURCE = `<h1>PRD: Agent-authored plan view</h1>
<h2>Context</h2>
<p>Replace the TipTap editor with a read-only, agent-controlled plan presented across three pages.</p>
<h2>Technical design</h2>
<p>HTML stays the source of truth; a derived projection feeds the step outline, the architecture page and the workflow DAG.</p>
<div data-diagram="mermaid"><pre>graph TD; A[HTML source] --> B[PlanPrd projection]; B --> C[Main outline]; B --> D[Architecture]; B --> E[Workflow DAG];</pre></div>
<section data-stage="01" data-title="Read model" data-depends-on="" data-complexity="low" data-execution-status="completed">
<h3>Intent</h3><p>Pure selectors derived from <code>PlanPrd</code>.</p>
<h3>Approach</h3><ol><li>Add <code>plan-view.ts</code>.</li><li>Unit test the topological order.</li></ol>
<ul data-files><li data-change="A" data-added="206" data-removed="0">packages/core/src/plan-view.ts</li></ul>
<div data-acceptance="01.1" data-status="passed" data-evidence="13 tests green">Selectors split PlanPrd into three views.</div>
</section>
<section data-stage="02" data-title="Drop TipTap" data-depends-on="01" data-complexity="high">
<div data-assignment data-agent-id="worker-02" data-cli="codex" data-model="gpt-5.6-sol" data-reason="High complexity route." data-status="running"></div>
<h3>Intent</h3><p>Read-only renderer of sanitized HTML.</p>
<ul data-files><li data-change="A" data-added="240" data-removed="0">packages/ui/src/composites/plan-doc/plan-doc-view.tsx</li><li data-change="D" data-added="0" data-removed="812">packages/ui/src/composites/plan-doc/plan-doc-editor.tsx</li></ul>
<div data-acceptance="02.1" data-status="pending">No @tiptap import remains.</div>
</section>
<h2>Testing</h2>
<p>pnpm typecheck, pnpm test, pnpm lint.</p>`

export const Full: Story = {
  render: () => (
    <div className="h-[720px] w-[760px] overflow-hidden bg-editor">
      <PlanDocView source={SOURCE} className="h-full" />
    </div>
  )
}

export const Empty: Story = {
  render: () => (
    <div className="h-[320px] w-[760px] overflow-hidden bg-editor">
      <PlanDocView source="<h1>PRD: [short outcome]</h1>" className="h-full" />
    </div>
  )
}
