/**
 * Bridges the Code Review tab to the presentational `CodeReviewView`. Mounted
 * (keyed by session id) when the Code Review tab is active; owns its data via
 * `useReview` (both the PR diff and the worktree's uncommitted diff + reverts).
 */
import { useCallback } from "react"
import type { Session } from "@starbase/core"
import { CodeReviewView } from "@starbase/ui"
import { useReview } from "./use-review.js"
import { useAdversarialReview } from "./use-adversarial-review.js"
import { getConversationActor } from "./conversation-registry.js"

/** The instruction handed to the session's agent to clean up one file. */
const deslopPrompt = (path: string): string =>
  `Refactor \`${path}\` to remove "slop": dead code, needless indirection, and ` +
  `copy-paste. Pull repeated logic into shared helpers so it's DRY, tighten ` +
  `names, and simplify control flow — WITHOUT changing behaviour. If the file ` +
  `is already clean, say so rather than churning it.`

export function ReviewPane({
  session,
  connected,
  onConnectGithub
}: {
  session: Session
  connected: boolean
  onConnectGithub: () => void
}) {
  const review = useReview(session)
  // Read-only here: the adversarial review is *run* from the Pull Request tab.
  // This tab renders whatever the last run produced, anchored to the diff.
  const adversarial = useAdversarialReview(session, { connected })

  const onDeslopFile = useCallback(
    (path: string) => {
      // Fix in place, on THIS session's own worktree, so the file the agent sees
      // is exactly the one under review — committed changes and uncommitted edits
      // alike. Driven through the session's conversation actor (a normal turn),
      // exactly like `sendFindingToAgent`, so the work and any approval gates
      // surface in the Conversation tab; it queues if a turn is already running.
      getConversationActor(session).send({ type: "SEND", text: deslopPrompt(path) })
    },
    [session]
  )

  return (
    <CodeReviewView
      files={review.files}
      reviewThreads={review.reviewThreads}
      activePath={review.activePath}
      fileDiffs={review.fileDiffs}
      drafts={review.drafts}
      routeTargetSession={session.title}
      connected={connected}
      source={review.source}
      prAvailable={review.prAvailable}
      localAvailable={review.localAvailable}
      onSetSource={review.setSource}
      onSelectFile={review.selectFile}
      onToggleViewed={review.toggleViewed}
      onAddDraft={review.addDraft}
      onRemoveDraft={review.removeDraft}
      onFinishReview={review.finishReview}
      onConnectGithub={onConnectGithub}
      onRevertLines={review.revertLines}
      onRevertFile={review.revertFile}
      review={adversarial.review}
      onSendFindingToAgent={adversarial.sendFindingToAgent}
      sentFindingIds={adversarial.sentFindingIds}
      onDeslopFile={onDeslopFile}
    />
  )
}
