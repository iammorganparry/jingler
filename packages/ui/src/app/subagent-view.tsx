import { useEffect, useRef } from "react"
import type {
  Message,
  ProviderId,
  SubagentFleetControlOutcome,
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

/** Token / duration / tool-call summary for the live child view. */
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
      {active ? (
        <p className="mt-3 text-[11px] leading-[1.5] text-dim">
          This agent is running. Its full transcript appears here once it records output.
        </p>
      ) : node.terminal?.summary ? (
        <div data-testid="subagent-final-output" className="mt-3 whitespace-pre-wrap text-[12px] leading-[1.55] text-text-body">
          {node.terminal.summary}
        </div>
      ) : (
        <p className="mt-3 text-[11px] leading-[1.5] text-dim">
          This agent finished without recording output.
        </p>
      )}
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
  readonly controlOutcome?: SubagentFleetControlOutcome | null
  readonly onOpenArtifact?: (path: string) => void
}

/** Full read-only child session selected from its chat-row tab. */
export function FleetAgentView({
  node,
  messages,
  providerId,
  loading = false,
  error = null,
  controlOutcome = null,
  onOpenArtifact
}: FleetAgentViewProps) {
         function renderAgentHeader() {
           return (<div className="flex items-center gap-2 border-b border-line px-[30px] py-2 text-[11px] text-muted-foreground">
        <div className="min-w-0 flex-1 truncate">
          <strong className="text-text-bright">{node?.agent ?? "Agent"}</strong>
          {node && <span> · {node.task}</span>}
        </div>
        {node?.artifacts.map((artifact) => (
          <button
            key={artifact.path}
            type="button"
            onClick={() => onOpenArtifact?.(artifact.path)}
            className="flex-none rounded border border-line px-1.5 py-0.5 text-[10px] text-blue hover:bg-panel"
          >
            {artifact.label ?? artifact.path.split("/").at(-1)}
          </button>
        ))}
      </div>)
         }

         function renderEmptyTranscript() {
           return (!loading && messages.length === 0 && (
            // A workflow node is an orchestrator with no pi session of its
            // own — its output lives in the step agents it spawns. Saying
            // "not available yet" for one promised a transcript that could
            // never arrive. An agent node, in contrast, always has live
            // activity to show even before any transcript is readable.
            node?.nodeKind === "workflow" ? (
              <div className="space-y-2">
                {node.terminal !== null && (
                  <p data-testid="workflow-outcome" className="text-[12px] text-text-body">
                    Workflow {node.terminal.reason}: {node.terminal.summary}
                  </p>
                )}
                <p className="text-[12px] text-dim">
                  This workflow orchestrates other agents and has no transcript of
                  its own — select one of its step agents to see their output.
                </p>
              </div>
            ) : node ? (
              <LiveAgentActivity node={node} />
            ) : (
              <p className="text-[12px] text-dim">
                The child session transcript is not available yet.
              </p>
            )
          ))
         }

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
      {renderAgentHeader()}
      {controlOutcome && (
        <div
          data-testid="subagent-control-outcome"
          role={controlOutcome.acknowledged ? "status" : "alert"}
          className={controlOutcome.acknowledged
            ? "border-b border-blue/30 bg-blue/[0.06] px-[30px] py-2 text-[11px] text-blue"
            : "border-b border-red/30 bg-red/[0.06] px-[30px] py-2 text-[11px] text-red"}
        >
          {controlOutcome.message}
        </div>
      )}
      <div ref={scrollRef} data-testid="fleet-agent-transcript-scroll" className="flex-1 overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[760px] space-y-6">
          {loading && <p className="text-[12px] text-dim">Loading child session…</p>}
          {error && <p role="alert" className="text-[12px] text-red">{error}</p>}
          {node?.attention && (
            <div data-testid="subagent-attention" className="rounded border border-purple/30 bg-purple/[0.06] p-3 text-[12px] text-text-body">
              {node.attention.message}
            </div>
          )}
          {renderEmptyTranscript()}
          {messages.map((message) => (
            <MessageTurn key={message.id} message={message} providerId={providerId} />
          ))}
          {messages.length > 0 && node?.terminal?.summary && (
            <section data-testid="subagent-final-output" className="rounded-xl border border-line bg-sunken px-4 py-3.5">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-dim">Final output</p>
              <div className="whitespace-pre-wrap text-[12px] leading-[1.55] text-text-body">
                {node.terminal.summary}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
