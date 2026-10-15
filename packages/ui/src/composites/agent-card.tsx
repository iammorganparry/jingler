import { Check, CircleAlert, Square } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"

export type AgentState = "working" | "flagged" | "done" | "failed" | "stopped"

/** End states draw a neutral icon row; only `failed` is red. */
const END_ICON = { done: Check, stopped: Square, failed: CircleAlert } as const
const END_WORD = { done: "done", stopped: "stopped", failed: "failed" } as const

/** A running-agent card (workflow view): file target, token count, status line; end states for done, stopped and failed. */
export function AgentCard({
  file,
  state,
  tokens,
  status,
  reason,
  onResume,
  onViewTranscript,
  className
}: {
  file: string
  state: AgentState
  tokens?: string
  /** Status line, e.g. "reading middleware…" or "⚠ 2 findings". */
  status?: string
  /** Why the agent failed; shown in red under the file name. */
  reason?: string
  /** Failed only: resume the agent. */
  onResume?: () => void
  /** Failed only: open the agent's transcript. */
  onViewTranscript?: () => void
  className?: string
}) {
  const working = state === "working"
  const flagged = state === "flagged"
  const failed = state === "failed"
  const EndIcon = state === "done" || state === "stopped" || failed ? END_ICON[state] : null
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg px-2.5 py-2",
        working && "border border-blue bg-surface shadow-[0_0_0_3px] shadow-blue/[0.12]",
        (flagged || failed) && "border border-red/30 bg-panel",
        (state === "done" || state === "stopped") && "border border-line bg-panel",
        className
      )}
    >
      <div className="flex items-center gap-[7px]">
        {EndIcon ? (
          <EndIcon
            aria-hidden
            data-testid={`agent-card-icon-${state}`}
            className={cn("size-3 flex-none", failed ? "text-state-failed" : "text-muted-foreground")}
          />
        ) : (
          <StatusDot tone={working ? "bg-yellow" : "bg-green"} size={working ? 8 : 7} pulse={working} />
        )}
        <span className="flex-1 truncate font-mono text-[11.5px] font-semibold text-text-bright">
          {file}
        </span>
        {EndIcon && !failed && (
          <span className="font-mono text-[9.5px] text-dim">{END_WORD[state as keyof typeof END_WORD]}</span>
        )}
        {tokens && <span className="font-mono text-[9.5px] text-muted-foreground">{tokens}</span>}
      </div>
      {failed && reason && <div className="font-mono text-[10px] text-state-failed">{reason}</div>}
      {status && (
        <div
          className={cn(
            "font-mono text-[10px]",
            flagged ? "text-red" : working ? "text-yellow" : EndIcon ? "text-dim" : "text-green"
          )}
        >
          {status}
        </div>
      )}
      {failed && (onResume || onViewTranscript) && (
        <div className="flex gap-1.5">
          {onResume && (
            <Button variant="secondary" size="sm" onClick={onResume}>
              Resume
            </Button>
          )}
          {onViewTranscript && (
            <Button variant="ghost" size="sm" onClick={onViewTranscript}>
              View transcript
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
