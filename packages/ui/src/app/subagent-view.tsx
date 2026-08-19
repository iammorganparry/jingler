import { useEffect, useRef, type ReactNode } from "react"
import type {
  Message,
  ProviderId,
  SubagentFleetNode,
  SubagentFleetStatus
} from "@jingler/core"
import { MessageTurn } from "../composites/message-turn.js"
import { StatusDot } from "../components/status-dot.js"

const ACTIVE_STATUSES: ReadonlySet<SubagentFleetStatus> = new Set([
  "queued",
  "running",
  "paused",
  "needs-attention"
])

/** Token / duration / tool-call summary, mirroring the Fleet dock's `metric`. */
const liveMetric = (node: SubagentFleetNode): string =>
  [
    node.usage.totalTokens > 0
      ? `${Math.round(node.usage.totalTokens / 100) / 10}k tokens`
      : null,
    node.usage.durationMs > 0
      ? `${Math.round(node.usage.durationMs / 1000)}s`
      : null,
    node.usage.toolCalls > 0
      ? `${node.usage.toolCalls} tool ${node.usage.toolCalls === 1 ? "call" : "calls"}`
      : null
  ]
    .filter(Boolean)
    .join(" · ")

/**
 * The live activity of a child that has no readable transcript yet.
 *
 * A running child surfaced only through the harness status RPC has no session
 * file to read (the RPC carries no transcript locator), so the transcript pane
 * would otherwise sit blank on "not available yet" for the child's whole life.
 * This shows what the harness DOES give us — the agent's task, current tool,
 * phase, and running totals — so every subagent has visible output and purpose.
 */
function LiveAgentActivity({ node }: { node: SubagentFleetNode }) {
  const active = ACTIVE_STATUSES.has(node.status)
  const metric = liveMetric(node)
  return (
    <div
      data-testid="fleet-agent-live"
      className="rounded-xl border border-line bg-sunken px-4 py-3.5"
    >
      <div className="flex items-center gap-2">
        <StatusDot tone={active ? "bg-yellow" : "bg-dim"} size={6} pulse={active} />
        <span className="text-[12px] font-medium text-text-bright">
          {active ? "Working…" : (node.terminal?.reason ?? node.status)}
        </span>
        {node.model && <span className="text-[10.5px] text-dim">{node.model}</span>}
      </div>
      {node.currentTool && (
        <p className="mt-2 text-[11.5px] text-blue">Using {node.currentTool}</p>
      )}
      {node.phase && (
        <p className="mt-1 text-[11px] text-muted-foreground">{node.phase}</p>
      )}
      {node.blocking && (
        <p className="mt-2 text-[11px] text-yellow">
          Waiting: {node.blocking.message}
        </p>
      )}
      {metric && (
        <p className="mt-2 font-mono text-[10.5px] text-dim">{metric}</p>
      )}
      <p className="mt-3 text-[11px] leading-[1.5] text-dim">
        {active
          ? "This agent is running. Its full transcript appears here once it records output."
          : "This agent finished without recording a separate transcript."}
      </p>
    </div>
  )
}

export interface VisibleAgentTranscript {
  readonly message: Message
  readonly providerId?: ProviderId
}

export function AgentView({ agent }: { agent: VisibleAgentTranscript }) {
  return <FleetAgentView messages={[agent.message]} providerId={agent.providerId} />
}

export interface FleetAgentViewProps {
  readonly node?: SubagentFleetNode
  readonly messages: ReadonlyArray<Message>
  readonly providerId?: ProviderId
  readonly loading?: boolean
  readonly error?: string | null
  readonly fleetSlot?: ReactNode
}

/** Full read-only child session, selected from the composer-adjacent Fleet. */
export function FleetAgentView({
  node,
  messages,
  providerId,
  loading = false,
  error = null,
  fleetSlot
}: FleetAgentViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const nodeId = node?.id ?? null
  // A child transcript is context for the LATEST activity: opening one at the
  // top showed the agent's greeting instead of what it is doing right now.
  // Jump to the end on selection (and once the transcript first loads)…
  const loadedKey = `${nodeId}:${messages.length > 0}`
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [loadedKey])
  // …and stay pinned while it grows, unless the operator scrolled away.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])
  return (
    <div data-testid="fleet-agent-transcript" className="flex min-h-0 flex-1 flex-col bg-editor">
      <div className="border-b border-line px-[30px] py-2 text-[11px] text-muted-foreground">
        <strong className="text-text-bright">{node?.agent ?? "Agent"}</strong>
        {node && <span> · {node.task}</span>}
      </div>
      <div ref={scrollRef} data-testid="fleet-agent-transcript-scroll" className="flex-1 overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[760px] space-y-6">
          {loading && <p className="text-[12px] text-dim">Loading child session…</p>}
          {error && <p role="alert" className="text-[12px] text-red">{error}</p>}
          {!(loading || error) && messages.length === 0 && (
            // A workflow node is an orchestrator with no pi session of its
            // own — its output lives in the step agents it spawns. Saying
            // "not available yet" for one promised a transcript that could
            // never arrive. An agent node, in contrast, always has live
            // activity to show even before any transcript is readable.
            node?.nodeKind === "workflow" ? (
              <p className="text-[12px] text-dim">
                This workflow orchestrates other agents and has no transcript of
                its own — select one of its step agents to see their output.
              </p>
            ) : node ? (
              <LiveAgentActivity node={node} />
            ) : (
              <p className="text-[12px] text-dim">
                The child session transcript is not available yet.
              </p>
            )
          )}
          {messages.map((message) => (
            <MessageTurn key={message.id} message={message} providerId={providerId} />
          ))}
        </div>
      </div>
      {fleetSlot && (
        <div className="flex-none px-[30px] pb-[18px] pt-[11px]">
          <div className="mx-auto w-full max-w-[760px] overflow-hidden rounded-2xl border border-line bg-sunken">
            {fleetSlot}
          </div>
        </div>
      )}
    </div>
  )
}
