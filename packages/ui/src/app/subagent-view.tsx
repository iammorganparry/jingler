import type { CliKind, Subagent } from "@starbase/core"
import { MessageTurn } from "../composites/message-turn.js"

/**
 * A watch-only view of one sub-agent's live transcript. A sub-agent runs
 * autonomously (the harness exposes no way to steer it mid-run), so there is no
 * composer or HITL affordance here — just its thinking/tool-calls/output as they
 * stream, rendered with the same `MessageTurn` the main transcript uses. The
 * sub-agent's whole run accrues onto a single rolling assistant message.
 *
 * There is no header. It used to carry the agent's name, its task and a
 * WATCH-ONLY lozenge on its own ruled row — every word of which the selected
 * pill in the rail immediately above already says, and the rule was a third
 * horizontal line in a pane that had just been cut down to one. A label directly
 * beneath the identical label it repeats reads as two different things until you
 * look twice.
 */
export function SubagentView({
  subagent,
  cli = "claude"
}: {
  subagent: Subagent
  /** The session's harness — the fallback when the sub-agent doesn't name its own. */
  cli?: CliKind
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-editor">
      <div className="flex-1 overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[760px]">
          <MessageTurn message={subagent.message} cli={subagent.cli ?? cli} />
        </div>
      </div>
    </div>
  )
}
