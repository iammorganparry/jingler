import * as React from "react"
import { SendHorizontal, Undo2, X } from "lucide-react"
import { Button } from "../components/button.js"
import type { JinglerDiffSide } from "../diff/pierre-selection.js"

/**
 * The inline comment box anchored below a selected diff range.
 *
 * Two outcomes, deliberately different: **Send to agent** hands the comment to
 * the session's agent now, while **Add to review** collects it as a draft in the
 * review sidebar to send (or post to GitHub) with the rest.
 */
export function InlineCommentComposer({
  path,
  side = "new",
  startLine,
  endLine,
  routeTargetSession,
  initialBody = "",
  onCancel,
  onAddToReview,
  onCommentAndSend,
  onRevert
}: {
  path: string
  side?: JinglerDiffSide
  startLine: number
  endLine: number
  /** Unused since sending no longer depends on GitHub; kept for callers. */
  connected?: boolean
  /** The session whose agent receives a sent comment; null disables sending. */
  routeTargetSession: string | null
  initialBody?: string
  onCancel: () => void
  onAddToReview: (draft: { body: string; routeToAgent: boolean }) => void
  /** Send the comment to the agent immediately. */
  onCommentAndSend: (draft: { body: string; routeToAgent: boolean }) => void
  /** Revert the selected lines (only wired for a session's uncommitted diff). */
  onRevert?: () => void
}) {
  const [body, setBody] = React.useState(initialBody)
  const name = path.split("/").pop() ?? path
  const range = endLine > startLine ? `L${startLine}–${endLine}` : `L${startLine}`
  const sidedRange = `${side} ${range}`
  const empty = body.trim().length === 0
  const canSend = !empty && routeTargetSession !== null
  const send = () => {
    if (canSend) onCommentAndSend({ body: body.trim(), routeToAgent: true })
  }

  return (
    <div className="max-w-[560px] overflow-hidden rounded-lg border border-blue/45 bg-panel shadow-[0_12px_30px_-14px_var(--sb-shadow-strong)]">
      <div className="flex items-center gap-2 border-b border-hairline bg-blue/[0.06] px-[11px] py-2">
        <span className="text-[11.5px] font-semibold text-text-bright">Comment on</span>
        <span className="rounded-md bg-blue/[0.14] px-2 py-0.5 font-mono text-[10.5px] text-blue">
          {name} {sidedRange}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Cancel comment"
          onClick={onCancel}
          className="text-dim hover:text-text"
        >
          <X size={13} />
        </button>
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            send()
          }
        }}
        placeholder="Suggest a change or ask the agent to fix this…"
        rows={3}
        className="w-full resize-none bg-transparent px-[13px] py-[10px] text-[13px] text-text-body outline-none placeholder:text-dim"
      />
      <div className="flex items-center gap-1.5 border-t border-hairline px-2 py-1.5">
        {onRevert && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-red hover:bg-red/10"
            onClick={onRevert}
          >
            <Undo2 size={12} />
            Revert {range}
          </Button>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={empty}
          onClick={() => onAddToReview({ body: body.trim(), routeToAgent: true })}
        >
          Add to review
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1 px-2.5 text-[11px]"
          disabled={!canSend}
          title={routeTargetSession ? `Send to ${routeTargetSession} (⌘↵)` : undefined}
          onClick={send}
        >
          <SendHorizontal size={12} />
          Send to agent
        </Button>
      </div>
    </div>
  )
}
