import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { PlanDocEditor } from "./plan-doc-editor.js"

/**
 * The Notion-like plan document editor — a full-document Tiptap surface that
 * edits an HTML plan in place. Use the **Editable** story to exercise the insert
 * toolbar (Heading, lists, Stage, Acceptance, Flow diagram), cycle an acceptance
 * status by clicking its pill, and edit a mermaid source live. **ReadOnly**
 * renders the same plan with the chrome and editing disabled.
 */

const PLAN_HTML = `<h1>PRD: Ship the plan doc editor</h1>
<h2>Context</h2>
<p>Plans are now HTML documents edited in a Notion-like Tiptap editor, replacing the old MDX engine.</p>
<h2>Goals</h2>
<ul><li>Round-trip the structural markup losslessly.</li><li>Let users insert plan widgets from a toolbar.</li></ul>
<section data-stage="01" data-title="Build the Tiptap nodes">
<h3>Intent</h3>
<p>Author the four custom nodes so structure survives a serialize/parse cycle.</p>
<h3>Approach</h3>
<ol><li>Write parseHTML/renderHTML for each node.</li><li>Add a React node view.</li></ol>
<div data-acceptance="01.1" data-status="passed" data-evidence="round-trip test is green">Nodes round-trip the data-attribute format.</div>
<div data-acceptance="01.2" data-status="pending">The insert toolbar adds every widget.</div>
<aside data-annotation="a1" data-stage="01" data-author="user" data-status="open" data-created-at="2026-07-29T10:00:00.000Z">Make sure the status pill cycles pending → passed → failed → waived on click.</aside>
</section>
<h2>Flow</h2>
<div data-diagram="mermaid"><pre>graph TD; Edit--&gt;Serialize--&gt;Sanitize--&gt;Validate</pre></div>`

const meta: Meta = { title: "Plan/Plan Doc Editor" }
export default meta
type Story = StoryObj

function Playground() {
  const [html, setHtml] = useState(PLAN_HTML)
  return (
    <div className="grid h-[680px] w-full grid-cols-[1fr_360px] gap-3 bg-editor p-4">
      <div className="min-h-0 overflow-hidden rounded-xl border border-line bg-canvas">
        <PlanDocEditor value={html} onChange={setHtml} className="h-full" />
      </div>
      <pre className="min-h-0 overflow-auto rounded-xl border border-line bg-sunken p-3 font-mono text-[10.5px] leading-[1.5] text-dim">
        {html}
      </pre>
    </div>
  )
}

export const Editable: Story = { render: () => <Playground /> }

export const ReadOnly: Story = {
  render: () => (
    <div className="h-[680px] w-full bg-editor p-4">
      <div className="mx-auto h-full max-w-[760px] overflow-hidden rounded-xl border border-line bg-canvas">
        <PlanDocEditor value={PLAN_HTML} editable={false} className="h-full" />
      </div>
    </div>
  )
}
