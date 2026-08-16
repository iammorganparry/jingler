import { useMemo, useState, type PointerEvent as ReactPointerEvent } from "react"
import type {
  SubagentFleetControlAction,
  SubagentFleetControlOutcome,
  SubagentFleetNode,
  SubagentFleetStatus
} from "@jingler/core"
import {
  ChevronRight,
  CircleStop,
  FastForward,
  GitBranch,
  MessageSquareMore,
  Pause,
  Play,
  Send,
  Users,
  X
} from "lucide-react"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"

const ACTIVE: ReadonlySet<SubagentFleetStatus> = new Set([
  "queued", "running", "paused", "needs-attention"
])
const DOT: Record<SubagentFleetStatus, { readonly tone: string; readonly pulse: boolean }> = {
  queued: { tone: "bg-dim", pulse: true },
  running: { tone: "bg-yellow", pulse: true },
  paused: { tone: "bg-blue", pulse: false },
  "needs-attention": { tone: "bg-purple", pulse: true },
  completed: { tone: "bg-green", pulse: false },
  failed: { tone: "bg-red", pulse: false },
  stopped: { tone: "bg-dim", pulse: false },
  unknown: { tone: "bg-dim", pulse: false }
}

export interface FleetDrawerProps {
  readonly nodes: ReadonlyArray<SubagentFleetNode>
  readonly selectedId: string
  readonly expanded: boolean
  readonly height: number
  readonly pending?: boolean
  readonly outcome?: SubagentFleetControlOutcome | null
  readonly embedded?: boolean
  readonly onSelect: (id: string) => void
  readonly onToggle: () => void
  readonly onResize: (height: number) => void
  readonly onControl: (node: SubagentFleetNode, action: SubagentFleetControlAction, message?: string, replyTo?: string) => void
  readonly canControl?: (
    node: SubagentFleetNode,
    action: SubagentFleetControlAction
  ) => boolean
  readonly canDismiss?: (node: SubagentFleetNode) => boolean
  readonly onDismiss?: (node: SubagentFleetNode) => void
  readonly onOpenArtifact?: (path: string) => void
}

const depthOf = (node: SubagentFleetNode, byId: ReadonlyMap<string, SubagentFleetNode>): number => {
  let depth = 0
  let parent = node.parentId
  const seen = new Set<string>([node.id])
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    depth += 1
    parent = byId.get(parent)?.parentId ?? null
  }
  return depth
}

const metric = (node: SubagentFleetNode): string => [
  node.usage.totalTokens > 0 ? `${Math.round(node.usage.totalTokens / 100) / 10}k tok` : null,
  node.usage.durationMs > 0 ? `${Math.round(node.usage.durationMs / 1000)}s` : null
].filter(Boolean).join(" · ")

function FleetHeader({ nodes, expanded, onToggle }: Pick<FleetDrawerProps, "nodes" | "expanded" | "onToggle">) {
  const active = nodes.filter((node) => ACTIVE.has(node.status)).length
  return (
    <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-surface/60">
      <ChevronRight className={cn("size-3.5 text-dim transition-transform", expanded && "rotate-90")} />
      <Users className="size-3.5 text-purple" />
      <span className="text-[12px] font-medium text-text-bright">Fleet</span>
      <span className="text-[11px] text-dim">{active} active · {nodes.length} total</span>
      {nodes.some((node) => node.status === "needs-attention") && (
        <span className="ml-auto rounded-full bg-purple/15 px-2 py-0.5 text-[10px] text-purple">Needs attention</span>
      )}
    </button>
  )
}

function FleetTree({ nodes, selectedId, onSelect }: Pick<FleetDrawerProps, "nodes" | "selectedId" | "onSelect">) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  return (
    <div className="overflow-auto border-r border-line p-1.5">
      <button type="button" data-testid="fleet-agent-main" aria-current={selectedId === "main" ? "page" : undefined} onClick={() => onSelect("main")} className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] outline-none", selectedId === "main" ? "bg-panel text-text-bright" : "text-muted-foreground hover:bg-panel/60")}>
        <GitBranch className="size-3.5 text-blue" /> Main
      </button>
      {nodes.map((node) => (
        <FleetTreeNode key={node.id} node={node} depth={depthOf(node, byId)} selected={selectedId === node.id} onSelect={onSelect} />
      ))}
    </div>
  )
}

function FleetTreeNode({ node, depth, selected, onSelect }: {
  readonly node: SubagentFleetNode
  readonly depth: number
  readonly selected: boolean
  readonly onSelect: (id: string) => void
}) {
  const dot = DOT[node.status]
  return (
    <button type="button" data-testid={`fleet-agent-${node.runId}`} data-agent-status={node.status} aria-current={selected ? "page" : undefined} onClick={() => onSelect(node.id)} className={cn("flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left outline-none", selected ? "bg-panel text-text-bright" : "text-muted-foreground hover:bg-panel/60")} style={{ paddingLeft: 8 + depth * 14 }}>
      <StatusDot tone={dot.tone} pulse={dot.pulse} size={7} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium">{node.agent}</span>
        <span className="block truncate text-[10.5px] text-dim">{node.task}</span>
      </span>
      <span className="flex-none text-[9.5px] text-dim">{metric(node)}</span>
    </button>
  )
}

function FleetDetails(props: Pick<FleetDrawerProps, "pending" | "outcome" | "onControl" | "canControl" | "canDismiss" | "onDismiss" | "onOpenArtifact"> & { readonly selected: SubagentFleetNode | null }) {
  const {
    selected,
    pending = false,
    outcome,
    onControl,
    canControl = () => true,
    canDismiss = () => false,
    onDismiss,
    onOpenArtifact
  } = props
  const [draft, setDraft] = useState("")
  if (!selected) return <div className="flex flex-1 items-center justify-center text-[11px] text-dim">Select an agent to inspect and control it.</div>
  const messageAction = selected.attention ? "reply" : "steer"
  const controlEnabled = canControl(selected, messageAction)
  const send = (action: "steer" | "follow-up" | "resume" | "reply") => {
    const message = draft.trim()
    if (!message) return
    onControl(selected, action, message, selected.attention?.requestId)
    setDraft("")
  }
  return (
    <div className="flex min-h-0 flex-col p-2.5">
      <FleetSummary node={selected} onOpenArtifact={onOpenArtifact} />
      <div className="mt-2 flex items-center gap-1.5">
        <LifecycleButtons node={selected} pending={pending} canControl={canControl} onControl={onControl} onResume={() => send("resume")} hasResumeMessage={Boolean(draft.trim())} />
        <input value={draft} disabled={!controlEnabled} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && send(selected.attention ? "reply" : "steer")} placeholder={controlEnabled ? (selected.attention ? "Reply to agent…" : "Steer agent…") : "Read-only agent"} aria-label={selected.attention ? "Reply to agent" : "Steer agent"} className="min-w-0 flex-1 rounded-md border border-line bg-editor px-2 py-1 text-[11px] outline-none focus:border-blue disabled:opacity-50" />
        <button type="button" aria-label="Steer agent" title="Steer" disabled={!controlEnabled || pending || !draft.trim()} onClick={() => send(selected.attention ? "reply" : "steer")} className="rounded p-1.5 text-blue hover:bg-panel disabled:opacity-40"><Send className="size-3.5" /></button>
        <button type="button" aria-label="Queue follow-up" title="Follow up after current work" disabled={!canControl(selected, "follow-up") || pending || !draft.trim()} onClick={() => send("follow-up")} className="rounded p-1.5 text-purple hover:bg-panel disabled:opacity-40"><FastForward className="size-3.5" /></button>
        {canDismiss(selected) && <button type="button" aria-label={`Close ${selected.agent}`} title="Close" onClick={() => onDismiss?.(selected)} className="rounded p-1.5 text-dim hover:bg-panel hover:text-text"><X className="size-3.5" /></button>}
      </div>
      {outcome && <p className="mt-1 text-[10px] text-dim"><MessageSquareMore className="mr-1 inline size-3" /><span data-testid="fleet-control-receipt" className="mr-1 rounded bg-panel px-1 py-0.5 uppercase">{outcome.deliveryStatus}</span>{outcome.message}</p>}
    </div>
  )
}

function FleetSummary({ node, onOpenArtifact }: { readonly node: SubagentFleetNode; readonly onOpenArtifact?: (path: string) => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center gap-2"><strong className="text-[12px] text-text-bright">{node.agent}</strong><span className="rounded bg-panel px-1.5 py-0.5 text-[9.5px] uppercase text-dim">{node.status}</span>{node.model && <span className="truncate text-[10px] text-dim">{node.model}</span>}</div>
      <p className="mt-1 text-[11.5px] text-muted-foreground">{node.task}</p>
      {node.currentTool && <p className="mt-1 text-[10.5px] text-blue">Using {node.currentTool}</p>}
      {node.attention && <div className="mt-2 rounded-md border border-purple/30 bg-purple/[0.06] p-2 text-[11px] text-text"><strong>{node.attention.reason}</strong><p className="mt-0.5 text-muted-foreground">{node.attention.message}</p></div>}
      {node.artifacts.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{node.artifacts.map((artifact) => <button key={artifact.path} type="button" onClick={() => onOpenArtifact?.(artifact.path)} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-blue hover:bg-panel">{artifact.label ?? artifact.path.split("/").at(-1)}</button>)}</div>}
    </div>
  )
}

function LifecycleButtons({ node, pending, canControl, onControl, onResume, hasResumeMessage }: { readonly node: SubagentFleetNode; readonly pending: boolean; readonly canControl: NonNullable<FleetDrawerProps["canControl"]>; readonly onControl: FleetDrawerProps["onControl"]; readonly onResume: () => void; readonly hasResumeMessage: boolean }) {
  return node.status === "paused" ? (
    <button type="button" title={hasResumeMessage ? "Resume with continuation" : "Enter a continuation message to resume"} aria-label="Resume agent" disabled={pending || !hasResumeMessage || !canControl(node, "resume")} onClick={onResume} className="rounded p-1.5 text-green hover:bg-panel disabled:opacity-40"><Play className="size-3.5" /></button>
  ) : (
    <>
      <button type="button" title="Interrupt" aria-label="Interrupt agent" disabled={pending || !ACTIVE.has(node.status) || !canControl(node, "interrupt")} onClick={() => onControl(node, "interrupt")} className="rounded p-1.5 text-yellow hover:bg-panel disabled:opacity-40"><Pause className="size-3.5" /></button>
      <button type="button" title="Stop" aria-label="Stop agent" disabled={pending || !ACTIVE.has(node.status) || !canControl(node, "stop")} onClick={() => onControl(node, "stop")} className="rounded p-1.5 text-red hover:bg-panel disabled:opacity-40"><CircleStop className="size-3.5" /></button>
    </>
  )
}

export function SubagentCompletionLinks({
  nodes,
  selectedId,
  onSelect,
  onOpenArtifact
}: {
  readonly nodes: ReadonlyArray<SubagentFleetNode>
  readonly selectedId: string
  readonly onSelect: (id: string) => void
  readonly onOpenArtifact?: (path: string) => void
}) {
  if (nodes.length === 0) return null
  return (
    <section data-testid="subagent-completion-links" aria-label="Recent agent results" className="border-t border-line/50 px-3 py-1.5">
      <span className="mr-2 text-[10px] uppercase text-dim">Recent results</span>
      {nodes.map((node) => (
        <span key={node.id} className="mr-2 inline-flex items-center gap-1">
          <button type="button" aria-current={selectedId === node.id ? "page" : undefined} onClick={() => onSelect(node.id)} className="text-[10.5px] text-blue hover:underline">{node.agent} transcript</button>
          {node.artifacts.map((artifact) => (
            <button key={artifact.path} type="button" onClick={() => onOpenArtifact?.(artifact.path)} className="text-[10px] text-purple hover:underline">{artifact.label ?? "artifact"}</button>
          ))}
        </span>
      ))}
    </section>
  )
}

export function FleetDrawer(props: FleetDrawerProps) {
  const selected = props.nodes.find((node) => node.id === props.selectedId) ?? null
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const startY = event.clientY
    const startHeight = props.height
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => props.onResize(startHeight + startY - next.clientY)
    const finish = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
  }
  if (props.nodes.length === 0) return null
  return (
    <section
      data-testid="fleet-drawer"
      aria-label="Subagent Fleet"
      data-embedded={props.embedded ? "true" : undefined}
      className={cn(
        "overflow-hidden",
        !props.embedded && "rounded-xl border border-line bg-sunken/80"
      )}
    >
      <FleetHeader nodes={props.nodes} expanded={props.expanded} onToggle={props.onToggle} />
      {props.expanded && <><button type="button" aria-label="Resize Fleet drawer" onPointerDown={startResize} className="block h-1 w-full cursor-row-resize border-t border-line/50 outline-none hover:bg-blue/20" /><div className="grid min-h-0 grid-cols-[minmax(180px,0.8fr)_minmax(220px,1.2fr)]" style={{ height: props.height }}><FleetTree nodes={props.nodes} selectedId={props.selectedId} onSelect={props.onSelect} /><FleetDetails selected={selected} pending={props.pending} outcome={props.outcome} onControl={props.onControl} canControl={props.canControl} canDismiss={props.canDismiss} onDismiss={props.onDismiss} onOpenArtifact={props.onOpenArtifact} /></div></>}
    </section>
  )
}
