import type { CliKind, Message, Subagent } from "@jingler/core"
import { MessageTurn } from "../composites/message-turn.js"

/** The transcript fields shared by Claude sub-agents, workers, and reviewers. */
export interface VisibleAgentTranscript {
  readonly message: Message
  readonly cli: CliKind
}

/**
 * A watch-only view of one visible agent's live transcript. These agents run
 * autonomously, so there is no composer or HITL affordance here — just their
 * thinking/tool-calls/output rendered with the main transcript's `MessageTurn`.
 *
 * There is no header. It used to carry the agent's name, its task and a
 * WATCH-ONLY lozenge on its own ruled row — every word of which the selected
 * pill in the rail immediately above already says, and the rule was a third
 * horizontal line in a pane that had just been cut down to one. A label directly
 * beneath the identical label it repeats reads as two different things until you
 * look twice.
 */
export function AgentView({ agent }: { agent: VisibleAgentTranscript }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-editor">
      <div className="flex-1 overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[760px]">
          <MessageTurn message={agent.message} cli={agent.cli} />
        </div>
      </div>
    </div>
  )
}

/** @deprecated Use `AgentView` with an already-normalized visible agent. */
export function SubagentView({
  subagent,
  cli = "claude"
}: {
  subagent: Subagent
  cli?: CliKind
}) {
  return (
    <AgentView
      agent={{ message: subagent.message, cli: subagent.cli ?? cli }}
    />
  )
}
