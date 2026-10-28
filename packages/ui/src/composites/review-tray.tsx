import { Trash2 } from "lucide-react"
import { Button } from "../components/button.js"
import { FileIcon } from "../components/file-icon.js"

export interface ReviewDraft {
  id: string
  path: string
  line: number
  endLine: number | null
  body: string
  routeToAgent: boolean
}

/**
 * The right rail of the Code Review view — the stack of pending inline comments,
 * the session they'll route to, and the two ways to finish the review.
 *
 * Keyboard: Delete/Backspace on a focused comment removes it; ⌘/Ctrl+Enter
 * submits the review (same action as the Submit button).
 */
export function ReviewTray({
  drafts,
  onRemoveDraft,
  onFinishReview
}: {
  drafts: readonly ReviewDraft[]
  onRemoveDraft: (id: string) => void
  onFinishReview: (mode: "comment_only" | "send_to_agent") => void
}) {
  const count = drafts.length
  const submit = () => {
    if (count > 0) onFinishReview("send_to_agent")
  }
  return (
    <div
      className="flex h-full w-full min-w-0 flex-col bg-panel"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submit()
        }
      }}
    >
      <div className="flex flex-1 flex-col gap-[9px] overflow-auto p-2.5">
        {count === 0 ? (
          <p className="px-1 pt-2 text-[12px] text-dim">
            Select lines in the diff to start a comment.
          </p>
        ) : (
          drafts.map((draft) => {
            const name = draft.path.split("/").pop() ?? draft.path
            const range =
              draft.endLine && draft.endLine > draft.line
                ? `L${draft.line}–${draft.endLine}`
                : `L${draft.line}`
            return (
              <div
                key={draft.id}
                tabIndex={0}
                role="group"
                aria-label={`Comment on ${name} ${range}`}
                onKeyDown={(event) => {
                  if (event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault()
                    onRemoveDraft(draft.id)
                  }
                }}
                className="overflow-hidden rounded-md border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center gap-2 bg-surface px-[11px] py-2">
                  <FileIcon path={draft.path} size={12} />
                  <span className="flex-1 truncate font-mono text-[10.5px] text-text-bright">
                    {name}
                  </span>
                  <span className="font-mono text-[10px] text-blue">{range}</span>
                  <button
                    type="button"
                    aria-label="Remove comment"
                    onClick={() => onRemoveDraft(draft.id)}
                    className="text-dim hover:text-red"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <p className="px-[10px] py-[7px] text-[12px] leading-[1.5] text-text">
                  {draft.body}
                </p>
              </div>
            )
          })
        )}
      </div>

      <div className="flex flex-none flex-col gap-[11px] border-t border-hairline p-[11px]">
        {/* Stacked, both neutral: side by side they clipped in the tray's width, and
            neither action is a brand-primary fill — submitting a review isn't a CTA. */}
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            className="w-full justify-center"
            disabled={count === 0}
            onClick={submit}
            title="Submit review (⌘↵)"
          >
            Send {count} to agent
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-center"
            disabled={count === 0}
            onClick={() => onFinishReview("comment_only")}
          >
            Comment only
          </Button>
        </div>
      </div>
    </div>
  )
}
