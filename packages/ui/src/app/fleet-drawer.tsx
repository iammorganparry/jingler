import type { PointerEvent as ReactPointerEvent } from "react"
import type {
  SubagentFleetControlAction,
  SubagentFleetControlOutcome,
  SubagentFleetNode,
  SubagentFleetStatus
} from "@jingler/core"
import {
  ChevronRight,
  CircleStop,
  GitBranch,
  MessageSquareMore,
  Pause,
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

function LifecycleButtons({ node, pending, canControl, onControl }: { readonly node: SubagentFleetNode; readonly pending: boolean; readonly canControl: NonNullable<FleetDrawerProps["canControl"]>; readonly onControl: FleetDrawerProps["onControl"] }) {
  // Resume lives in the composer: it requires a continuation message, and the
  // composer is where messages are typed — a paused agent's send resumes it.
  return node.status === "paused" ? (
    <button type="button" title="Stop" aria-label="Stop agent" disabled={pending || !canControl(node, "stop")} onClick={() => onControl(node, "stop")} className="rounded p-1.5 text-red hover:bg-panel disabled:opacity-40"><CircleStop className="size-3.5" /></button>
  ) : (
    <>
      <button type="button" title="Interrupt" aria-label="Interrupt agent" disabled={pending || !ACTIVE.has(node.status) || !canControl(node, "interrupt")} onClick={() => onControl(node, "interrupt")} className="rounded p-1.5 text-yellow hover:bg-panel disabled:opacity-40"><Pause className="size-3.5" /></button>
      <button type="button" title="Stop" aria-label="Stop agent" disabled={pending || !ACTIVE.has(node.status) || !canControl(node, "stop")} onClick={() => onControl(node, "stop")} className="rounded p-1.5 text-red hover:bg-panel disabled:opacity-40"><CircleStop className="size-3.5" /></button>
    </>
  )
}

/**
 * One agent in the Fleet grid. Selecting it swaps the transcript pane above to
 * that agent's output — the card carries the identity, live telemetry, and (only
 * while selected) the lifecycle controls the composer does not. There is no
 * separate detail panel: everything an operator needs sits on the cards.
 */
function AgentCard({
  node,
  selected,
  onSelect,
  pending = false,
  canControl = () => true,
  onControl,
  canDismiss = () => false,
  onDismiss,
  onOpenArtifact
}: Pick<FleetDrawerProps, "onSelect" | "pending" | "canControl" | "onControl" | "canDismiss" | "onDismiss" | "onOpenArtifact"> & {
  readonly node: SubagentFleetNode
  readonly selected: boolean
}) {
  const dot = DOT[node.status]
  const isWorkflow = node.nodeKind === "workflow"
  return (
    <div className={cn("flex flex-col rounded-lg border p-2.5", selected ? "border-blue/50 bg-panel" : "border-line bg-sunken/60 hover:bg-panel/50")}>
      <button
        type="button"
        data-testid={isWorkflow ? `fleet-workflow-${node.runId}` : `fleet-agent-${node.runId}`}
        data-agent-status={node.status}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(node.id)}
        className="min-w-0 text-left outline-none"
      >
        <div className="flex items-center gap-1.5">
          <StatusDot tone={dot.tone} pulse={dot.pulse} size={7} />
          <span className={cn("min-w-0 flex-1 truncate text-[11.5px] font-medium", isWorkflow ? "uppercase tracking-wide text-dim" : "text-text-bright")}>{node.agent}</span>
          <span className="flex-none rounded bg-panel px-1 py-0.5 text-[9px] uppercase text-dim">{node.status}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-[10.5px] text-muted-foreground">{node.task}</p>
        {node.currentTool && <p className="mt-1 truncate text-[10px] text-blue">Using {node.currentTool}</p>}
        {metric(node) && <p className="mt-1 font-mono text-[9.5px] text-dim">{metric(node)}</p>}
        {node.attention && <div className="mt-1.5 rounded border border-purple/30 bg-purple/[0.06] p-1.5 text-[10px] text-text"><strong>{node.attention.reason}</strong> {node.attention.message}</div>}
      </button>
      {selected && node.artifacts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {node.artifacts.map((artifact) => (
            <button key={artifact.path} type="button" onClick={() => onOpenArtifact?.(artifact.path)} className="rounded border border-line px-1.5 py-0.5 text-[9.5px] text-blue hover:bg-panel">{artifact.label ?? artifact.path.split("/").at(-1)}</button>
          ))}
        </div>
      )}
      {selected && !isWorkflow && (
        <div className="mt-1.5 flex items-center gap-1 border-t border-line/50 pt-1.5">
          <LifecycleButtons node={node} pending={pending} canControl={canControl} onControl={onControl} />
          {canDismiss(node) && <button type="button" aria-label={`Close ${node.agent}`} title="Close" onClick={() => onDismiss?.(node)} className="rounded p-1 text-dim hover:bg-panel hover:text-text"><X className="size-3.5" /></button>}
        </div>
      )}
    </div>
  )
}

/** The main agent — the first card, selecting it returns to the main transcript. */
function MainCard({ selected, onSelect }: { readonly selected: boolean; readonly onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      data-testid="fleet-agent-main"
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelect("main")}
      className={cn("flex flex-col rounded-lg border p-2.5 text-left outline-none", selected ? "border-blue/50 bg-panel" : "border-line bg-sunken/60 hover:bg-panel/50")}
    >
      <div className="flex items-center gap-1.5">
        <GitBranch className="size-3.5 text-blue" />
        <span className="text-[11.5px] font-medium text-text-bright">Main</span>
      </div>
      <p className="mt-1 text-[10.5px] text-muted-foreground">Main agent</p>
    </button>
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
          {node.sessionFile !== null ? (
            <button type="button" aria-current={selectedId === node.id ? "page" : undefined} onClick={() => onSelect(node.id)} className="text-[10.5px] text-blue hover:underline">{node.agent} transcript</button>
          ) : null}
          {node.artifacts.map((artifact) => (
            <button key={artifact.path} type="button" onClick={() => onOpenArtifact?.(artifact.path)} className="text-[10px] text-purple hover:underline">{artifact.label ?? "artifact"}</button>
          ))}
        </span>
      ))}
    </section>
  )
}

export function FleetDrawer(props: FleetDrawerProps) {
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
      {props.expanded && (
        <>
          <button type="button" aria-label="Resize Fleet drawer" onPointerDown={startResize} className="block h-1 w-full cursor-row-resize border-t border-line/50 outline-none hover:bg-blue/20" />
          <div className="min-h-0 overflow-auto p-2" style={{ height: props.height }}>
            {/* A flat 4-column grid that wraps to new rows — no detail panel; the
                selected card carries controls and clicking swaps the output above. */}
            <div className="grid grid-cols-4 gap-2">
              <MainCard selected={props.selectedId === "main"} onSelect={props.onSelect} />
              {props.nodes.map((node) => (
                <AgentCard
                  key={node.id}
                  node={node}
                  selected={props.selectedId === node.id}
                  onSelect={props.onSelect}
                  pending={props.pending}
                  canControl={props.canControl}
                  onControl={props.onControl}
                  canDismiss={props.canDismiss}
                  onDismiss={props.onDismiss}
                  onOpenArtifact={props.onOpenArtifact}
                />
              ))}
            </div>
            {props.outcome && (
              <p className="mt-2 px-1 text-[10px] text-dim">
                <MessageSquareMore className="mr-1 inline size-3" />
                <span data-testid="fleet-control-receipt" className="mr-1 rounded bg-panel px-1 py-0.5 uppercase">{props.outcome.deliveryStatus}</span>
                {props.outcome.message}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
