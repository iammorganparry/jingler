import { ConfirmDialog } from "../components/confirm-dialog.js"
import { discardCommentsTitle } from "./plan-comment-drafts.js"

/** "Discard N unsaved comments?" gate; Keep editing cancels, Discard runs the held action. */
export function DiscardCommentsDialog({ open, count, onOpenChange, onDiscard }: {
  readonly open: boolean
  readonly count: number
  readonly onOpenChange: (open: boolean) => void
  readonly onDiscard: () => void | Promise<void>
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={discardCommentsTitle(count)}
      description="Unsaved comments are lost if you continue."
      cancelLabel="Keep editing"
      confirmLabel="Discard"
      destructive
      onConfirm={onDiscard}
    />
  )
}
