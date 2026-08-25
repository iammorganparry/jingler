import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Bot, CheckCircle2, Code2, FileCode2, GitBranch, MessageSquare, Settings, Shield, Sparkles, Terminal } from "lucide-react"
import { MotionInput, MotionSelect, MotionSwitch, MotionTabs, RangeSlider, ThemeToggle } from "../../components/beui/index.js"
import { Badge } from "../../components/badge.js"
import { Button } from "../../components/button.js"
import { Markdown } from "../../components/markdown.js"
import {
  AgentActivity,
  AgentCodeBlock,
  AgentFileDiff,
  AgentLoadingState,
  AgentMessage,
  AgentTodoList,
  AISidebar,
  ApprovalCard,
  BEUI_AGENT_COMPONENTS,
  ChatApp,
  CitationMarker,
  Citations,
  ImageGeneration,
  MessageBubble,
  MessageScroller,
  PromptInput,
  StreamingResponse,
  ToolApproval,
  ToolResult
} from "./index.js"

const meta: Meta = { title: "Experience/BeUI Full Chat App", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const sessions = [
  { id: "today", label: "Today", type: "folder" as const, children: [
    { id: "beui", label: "Adopt BeUI component system", icon: <Sparkles className="size-3.5" />, badge: <Badge size="xs" tone="green">live</Badge> },
    { id: "auth", label: "Fix provider auth", icon: <Shield className="size-3.5" /> }
  ]},
  { id: "earlier", label: "Earlier", type: "folder" as const, children: [
    { id: "perf", label: "Profile transcript rendering", icon: <Terminal className="size-3.5" /> }
  ]}
]

const tasks = [
  { id: "1", title: "Map the official component registry", status: "done" as const, meta: "56" },
  { id: "2", title: "Build themed Motion atoms", status: "done" as const, meta: "39" },
  { id: "3", title: "Compose Agent molecules", status: "running" as const, meta: "17" },
  { id: "4", title: "Run visual QA", status: "pending" as const }
]

function FullExperience() {
  const [view, setView] = useState("chat")
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState<"pending" | "allowed" | "denied">("pending")
  const [choice, setChoice] = useState("keep")
  const [theme, setTheme] = useState<"dark" | "light">("dark")
  const [motion, setMotion] = useState(true)
  const [density, setDensity] = useState(42)
  const [model, setModel] = useState("sonnet")
  const header = <><div className="flex min-w-0 flex-1 items-center gap-2"><Bot className="size-4 text-brand" /><strong className="truncate text-[12px] text-text-bright">Adopt BeUI component system</strong><Badge size="xs" tone="purple">plan</Badge><span className="flex items-center gap-1 font-mono text-[9.5px] text-dim"><GitBranch className="size-3" />feat/adopt-beui</span></div><MotionTabs value={view} onChange={setView} variant="underline" items={[{ value: "chat", label: <span className="flex items-center gap-1"><MessageSquare className="size-3" />Chat</span> }, { value: "settings", label: <span className="flex items-center gap-1"><Settings className="size-3" />Settings</span> }]} /></>
  return <div className="h-screen min-h-[720px] bg-canvas p-4"><div className="mx-auto h-full max-w-[1440px] overflow-hidden rounded-xl border border-line shadow-2xl"><ChatApp
    sidebar={<AISidebar items={sessions} activeId="beui" header={<span className="font-semibold text-text-bright">Jingler</span>} footer={<div className="flex items-center gap-2 text-[10px] text-muted-foreground"><span className="size-2 rounded-full bg-green" />All systems ready</div>} />}
    header={header}
    conversation={view === "chat" ? <ChatTranscript permission={permission} setPermission={setPermission} choice={choice} setChoice={setChoice} busy={busy} /> : <SettingsExperience theme={theme} setTheme={setTheme} motion={motion} setMotion={setMotion} density={density} setDensity={setDensity} model={model} setModel={setModel} />}
    composer={view === "chat" ? <PromptInput value={draft} onValueChange={setDraft} busy={busy} onStop={() => setBusy(false)} onSubmit={() => { setBusy(true); setDraft("") }} actions={<><button className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-surface">＋ Attach</button><button className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-surface">/ Skills</button></>} model={<Badge size="xs" tone="blue">Claude Sonnet</Badge>} footer={<div className="flex items-center gap-2 font-mono text-[9px] text-dim"><span>bright-feynman</span><span>·</span><span className="text-green">39 atoms</span><span>·</span><span className="text-purple">17 molecules</span></div>} /> : <div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>Settings save automatically</span><Button size="sm" onClick={() => setView("chat")}>Back to chat</Button></div>}
    auxiliary={view === "chat" ? <AgentTodoList items={tasks} /> : undefined}
  /></div></div>
}

function ChatTranscript({ permission, setPermission, choice, setChoice, busy }: { permission: "pending" | "allowed" | "denied"; setPermission: (value: "pending" | "allowed" | "denied") => void; choice: string; setChoice: (value: string) => void; busy: boolean }) {
  return <MessageScroller busy={busy} followOutput className="h-full" viewportClassName="h-full" contentClassName="mx-auto flex max-w-[760px] flex-col gap-5 px-6 py-6">
    <AgentMessage from="user" name="You"><MessageBubble tone="user">Flesh out our atoms with BeUI’s Motion and Agent components, then show the full experience in Storybook.</MessageBubble></AgentMessage>
    <AgentMessage from="assistant" name="Claude" avatar={<Bot className="size-3.5 text-brand" />}><MessageBubble><StreamingResponse sources={<Citations items={[{ id: "registry", label: "BeUI registry", url: "https://beui.dev/r", excerpt: "Official source, dependency, and component metadata." }]} />} onCopy={() => {}}><><Markdown>{"I mapped all **56 approved entries** and kept Jingler’s theme. The catalog now exposes every Motion atom and Agent molecule."}</Markdown><CitationMarker index={1} /></></StreamingResponse></MessageBubble></AgentMessage>
    <AgentActivity items={[{ id: "1", label: "Read official registry", status: "success", timestamp: "0.8s" }, { id: "2", label: "Mapped dependency collisions", detail: "Reused Motion, Shiki, Radix, TanStack Virtual, and Paper shaders.", status: "success", timestamp: "1.3s" }, { id: "3", label: "Building Agent molecules", status: busy ? "running" : "success", timestamp: "now" }]} />
    <ToolResult title="Typecheck" status="success" summary="@jingler/ui"><AgentCodeBlock language="text" code={"> @jingler/ui typecheck\n> tsc --noEmit\n\nDone in 2.1s"} /></ToolResult>
    <AgentFileDiff path="packages/ui/src/composites/beui/messages.tsx" added={84} removed={0} lines={[{ type: "context", oldLine: 1, newLine: 1, content: "import { useEffect } from \"react\"" }, { type: "add", newLine: 2, content: "export function MessageScroller() {" }, { type: "add", newLine: 3, content: "  // follows only at the live edge" }, { type: "add", newLine: 4, content: "}" }]} />
    <ToolApproval title="Allow Storybook build?" detail="Runs the local production Storybook compiler. No network writes." command="pnpm --filter @jingler/ui build-storybook" status={permission} rememberLabel="Always allow pnpm builds" onDecision={decision => setPermission(decision === "deny" ? "denied" : "allowed")} />
    <ApprovalCard title="Choose the default transcript density" description="This only changes the mock; the product keeps the operator’s current setting." value={choice} onValueChange={setChoice} choices={[{ value: "keep", label: "Keep current density", description: "Best for code-heavy sessions" }, { value: "roomy", label: "Use roomier messages", description: "More whitespace around each turn" }]} onSubmit={() => {}} submitLabel="Apply" />
    <ImageGeneration alt="Generated component gallery preview" status="complete" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='450'%3E%3Cdefs%3E%3ClinearGradient id='g'%3E%3Cstop stop-color='%23141414'/%3E%3Cstop offset='1' stop-color='%23ef3f57'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='450' fill='url(%23g)'/%3E%3Ctext x='400' y='225' fill='white' font-family='sans-serif' font-size='36' text-anchor='middle'%3EJingler × BeUI%3C/text%3E%3C/svg%3E" prompt="Full component experience" />
    {busy && <AgentLoadingState phrases={["Checking the catalog", "Composing the workspace", "Preparing visual QA"]} detail="Live output will stay pinned until you scroll away." />}
  </MessageScroller>
}

function SettingsExperience({ theme, setTheme, motion, setMotion, density, setDensity, model, setModel }: { theme: "dark" | "light"; setTheme: (value: "dark" | "light") => void; motion: boolean; setMotion: (value: boolean) => void; density: number; setDensity: (value: number) => void; model: string; setModel: (value: string) => void }) {
  return <div className="h-full overflow-y-auto"><div className="mx-auto flex max-w-3xl flex-col gap-5 p-7"><div><h2 className="text-lg font-semibold text-text-bright">Settings</h2><p className="mt-1 text-[12px] text-muted-foreground">Themed controls composed from the new Motion catalog.</p></div><SettingSection title="Appearance"><SettingRow title="Theme" description="Keep Jingler’s palette while switching the active ground."><div className="flex items-center gap-2"><ThemeToggle theme={theme} onToggle={() => setTheme(theme === "dark" ? "light" : "dark")} /><MotionTabs value={theme} onChange={setTheme} items={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /></div></SettingRow><SettingRow title="Interface motion" description="Transforms stop when reduced motion is requested."><MotionSwitch checked={motion} onCheckedChange={setMotion} /></SettingRow><SettingRow title="Transcript density" description={`${density}% spacing`}><div className="w-48"><RangeSlider value={density} onChange={setDensity} /></div></SettingRow></SettingSection><SettingSection title="Agent defaults"><SettingRow title="Model" description="Default model for new sessions."><div className="w-48"><MotionSelect value={model} onValueChange={setModel} options={[{ value: "sonnet", label: "Claude Sonnet" }, { value: "opus", label: "Claude Opus" }, { value: "codex", label: "GPT Codex" }]} /></div></SettingRow><SettingRow title="Project path" description="Used when creating a local session."><div className="w-64"><MotionInput value="~/repos/jingler" left={<FileCode2 className="size-3.5" />} readOnly /></div></SettingRow></SettingSection><div className="flex items-center justify-between rounded-xl border border-green/25 bg-green/[0.04] p-4"><span className="flex items-center gap-2 text-[11px] text-green"><CheckCircle2 className="size-4" />{BEUI_AGENT_COMPONENTS.length}/17 Agent components available</span><span className="font-mono text-[9px] text-dim">auto-saved</span></div></div></div>
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="overflow-hidden rounded-xl border border-line bg-panel"><h3 className="border-b border-line px-4 py-3 text-[12px] font-semibold text-text-bright">{title}</h3><div className="divide-y divide-line">{children}</div></section> }
function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <div className="flex min-h-20 items-center gap-5 px-4 py-3"><div className="min-w-0 flex-1"><strong className="text-[11.5px] text-text">{title}</strong><p className="mt-1 text-[10.5px] text-dim">{description}</p></div>{children}</div> }

export const ChatAndSettings: Story = { render: () => <FullExperience /> }
