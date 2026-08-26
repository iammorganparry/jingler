import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { ToolResult, ToolResultOutput } from "../components/beui/tool-result.js"
import { ToolCall } from "./tool-call.js"

const command = "pnpm --filter @jingler/ui test"
const output = `RUN  v3.2.7 packages/ui
✓ 128 test files passed
✓ 1016 tests passed
Done in 55.7s`
const meta: Meta = { title: "Review/Tool Result", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

function Current() {
  const [open, setOpen] = useState(true)
  return <ToolCall status="success" name="Bash" target={command} meta="exit 0" expanded={open} onToggle={() => setOpen(!open)}><div className="border-t border-line bg-editor"><pre className="max-h-[220px] overflow-auto px-3 py-2 font-mono text-[11px] leading-[1.5] text-muted-foreground">{output}</pre></div></ToolCall>
}
function Proposed() {
  return <ToolResult tool="Bash" title={command} meta="exit 0" status="success" kind="terminal" defaultOpen collapseOnComplete={false} maxHeight={220} copyText={output}><ToolResultOutput language="bash">{output}</ToolResultOutput></ToolResult>
}
export const CurrentVsBeUI: Story = { render: () => <main className="min-h-screen bg-canvas p-5 text-text"><header className="mx-auto mb-5 max-w-[1180px]"><div className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">Side-by-side review</div><h1 className="mt-1 text-lg font-semibold text-text-bright">Bash Tool Result</h1><p className="mt-1 text-xs text-muted-foreground">Current production treatment beside the exact beui.dev Tool Result.</p></header><div className="mx-auto grid max-w-[1180px] grid-cols-2 gap-4"><section className="rounded-xl border border-line bg-editor p-5"><h2 className="mb-4 text-xs font-semibold text-muted-foreground">Current Jingler</h2><Current /></section><section className="rounded-xl border border-line bg-editor p-5"><h2 className="mb-4 text-xs font-semibold text-muted-foreground">Exact BeUI</h2><Proposed /></section></div></main> }
