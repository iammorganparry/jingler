import { useMachine } from "@xstate/react"
import { Button } from "./button.js"
import { commentComposerMachine, type CommentComposerInput } from "./comment-composer-machine.js"
import { Textarea } from "./textarea.js"

export interface CommentComposerProps extends CommentComposerInput {
  /** Offer `Close with comment`; false for an issue that is already closed. */
  readonly canClose?: boolean
}

/** Issue comment box under a thread: `Comment` primary, `Close with comment` secondary; a failed post keeps the draft and shows an inline error. */
export function CommentComposer({ post, canClose = true }: CommentComposerProps) {
  const [snapshot, send] = useMachine(commentComposerMachine, { input: { post } })
  const { draft, error } = snapshot.context
  const posting = snapshot.matches("posting")
  const empty = draft.trim().length === 0
  return (
    <div data-testid="comment-composer" className="flex flex-col gap-2">
      <Textarea
        aria-label="Leave a comment"
        placeholder="Leave a comment…"
        value={draft}
        disabled={posting}
        onChange={(event) => send({ type: "CHANGE", draft: event.target.value })}
      />
      {error && (
        <p role="alert" data-testid="comment-composer-error" className="text-[12px] text-state-failed">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {canClose && (
          <Button variant="secondary" size="sm" disabled={posting || empty} onClick={() => send({ type: "SUBMIT", close: true })}>
            Close with comment
          </Button>
        )}
        <Button size="sm" disabled={posting || empty} onClick={() => send({ type: "SUBMIT", close: false })}>
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  )
}
