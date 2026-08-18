import type { ReactNode } from "react"
import type { Message, ProviderId, SubagentFleetNode } from "@jingler/core"
import { MessageTurn } from "../composites/message-turn.js"

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
  return (
    <div data-testid="fleet-agent-transcript" className="flex min-h-0 flex-1 flex-col bg-editor">
      <div className="border-b border-line px-[30px] py-2 text-[11px] text-muted-foreground">
        <strong className="text-text-bright">{node?.agent ?? "Agent"}</strong>
        {node && <span> · {node.task}</span>}
      </div>
      <div data-testid="fleet-agent-transcript-scroll" className="flex-1 overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[760px] space-y-6">
          {loading && <p className="text-[12px] text-dim">Loading child session…</p>}
          {error && <p role="alert" className="text-[12px] text-red">{error}</p>}
          {!(loading || error) && messages.length === 0 && (
            // A workflow node is an orchestrator with no pi session of its
            // own — its output lives in the step agents it spawns. Saying
            // "not available yet" for one promised a transcript that could
            // never arrive.
            <p className="text-[12px] text-dim">
              {node?.nodeKind === "workflow"
                ? "This workflow orchestrates other agents and has no transcript of its own — select one of its step agents to see their output."
                : "The child session transcript is not available yet."}
            </p>
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
