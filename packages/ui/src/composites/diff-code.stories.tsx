import type { Meta, StoryObj } from "@storybook/react-vite"
import { CodeBlock } from "../components/beui/code-block.js"
import { FileDiff } from "../components/beui/file-diff.js"
import { FileIcon } from "../components/file-icon.js"
import { DiffView } from "../diff/diff-view.js"

const code = `export async function streamTurn(prompt: string) {
  const session = await loadSession()
  for await (const event of agent.stream(prompt)) {
    session.append(event)
  }
  return session
}`
const patch = `diff --git a/session.ts b/session.ts
--- a/session.ts
+++ b/session.ts
@@ -1,4 +1,5 @@
 export async function streamTurn(prompt: string) {
-  return agent.run(prompt)
+  const session = await loadSession()
+  return agent.run(prompt, session)
 }
`
const lines = [
  { id: "1", type: "context" as const, oldLine: 1, newLine: 1, content: "export async function streamTurn(prompt: string) {" },
  { id: "2", type: "removed" as const, oldLine: 2, content: "  return agent.run(prompt)" },
  { id: "3", type: "added" as const, newLine: 2, content: "  const session = await loadSession()" },
  { id: "4", type: "added" as const, newLine: 3, content: "  return agent.run(prompt, session)" },
  { id: "5", type: "context" as const, oldLine: 3, newLine: 4, content: "}" }
]
const meta: Meta = { title: "Review/Diff and Code", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

function Compare({ title, current, proposed }: { title: string; current: React.ReactNode; proposed: React.ReactNode }) {
  return <main className="min-h-screen bg-canvas p-5 text-text"><header className="mx-auto mb-5 max-w-[1180px]"><div className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">Side-by-side review</div><h1 className="mt-1 text-lg font-semibold text-text-bright">{title}</h1></header><div className="mx-auto grid max-w-[1180px] grid-cols-2 gap-4"><section className="rounded-xl border border-line bg-editor p-5"><h2 className="mb-4 text-xs font-semibold text-muted-foreground">Current Jingler</h2>{current}</section><section className="rounded-xl border border-line bg-editor p-5"><h2 className="mb-4 text-xs font-semibold text-muted-foreground">Exact BeUI</h2>{proposed}</section></div></main>
}

export const FileDiffCurrentVsBeUI: Story = { render: () => <Compare title="File Diff" current={<div className="h-[260px]"><DiffView patch={patch} options={{ stickyHeader: false }} /></div>} proposed={<FileDiff file="session.ts" fileIcon={<FileIcon path="session.ts" size={16} />} lines={lines} status="streaming" collapseOnComplete={false} language="typescript" copyText={patch} />} /> }
export const CodeBlockCurrentVsBeUI: Story = { render: () => <Compare title="Streaming Code Block" current={<pre className="overflow-auto rounded-md border border-line bg-sunken p-4 font-mono text-xs text-text-body"><code>{code}</code></pre>} proposed={<CodeBlock code={code} filename="session.ts" fileIcon={<FileIcon path="session.ts" size={14} />} language="typescript" status="streaming" highlightLines={[3,4]} />} /> }
