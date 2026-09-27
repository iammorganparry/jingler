/**
 * The desktop half of changes review: binds the session's review data (PR and
 * uncommitted diffs, drafts, viewed markers, adversarial findings) to the three
 * places it now renders — the Explorer's changed-files filter, the Files view's
 * review diff, and the review tray beside the panes.
 */
import { useCallback, useMemo } from "react"
import type { Session } from "@jingler/core"
import { workspaceModeOf } from "@jingler/core"
import {
  ChangedFilesExplorer,
  ReviewSidebar,
  SegmentedControl
} from "@jingler/ui"
import { getConversationActor } from "./conversation-registry.js"
import {
  setReviewFilter,
  setReviewFocused,
  useReviewFocused,
  type ReviewFilter
} from "./review-store.js"
import { useAdversarialReview } from "./use-adversarial-review.js"
import { useReview } from "./use-review.js"

/** The instruction handed to the session's agent to clean up one file. */
const deslopPrompt = (path: string): string =>
  `Refactor \`${path}\` to remove "slop": dead code, needless indirection, and ` +
  `copy-paste. Pull repeated logic into shared helpers so it's DRY, tighten ` +
  `names, and simplify control flow — WITHOUT changing behaviour. If the file ` +
  `is already clean, say so rather than churning it.`

export function useChangesReview(session: Session, connected: boolean) {
  const review = useReview(session)
  // Read-only: the adversarial review is *run* from the Pull Request tab; its
  // findings anchor to the PR diff wherever that diff renders.
  const adversarial = useAdversarialReview(session, { connected })
  const worktree = workspaceModeOf(session) === "worktree"

  const deslopFile = useCallback(
    // Fix in place, on this session's own worktree, through its conversation
    // actor (a normal turn) — it queues if a turn is already running.
    (path: string) => getConversationActor(session).send({ type: "SEND", text: deslopPrompt(path) }),
    [session]
  )
  const focused = useReviewFocused()
  const toggleFocus = useCallback(() => setReviewFocused(!focused), [focused])

  return {
    review,
    adversarial,
    deslopFile,
    focused,
    toggleFocus,
    revertLines: worktree ? review.revertLines : undefined,
    revertFile: worktree ? review.revertFile : undefined
  }
}

/** What the Changes rail button does: show this session's changes in the Explorer. */
export const revealSessionChanges = (session: Session): void =>
  setReviewFilter(session.id, session.prNumber, session.prNumber != null ? "pr" : "local")

export function ExplorerChangesFilter({
  session,
  value,
  onChange
}: {
  readonly session: Session
  readonly value: ReviewFilter
  readonly onChange: (filter: ReviewFilter) => void
}) {
  return (
    <SegmentedControl<ReviewFilter>
      value={value}
      onChange={onChange}
      className="w-full"
      items={[
        { value: "all", label: "All files" },
        { value: "local", label: "Uncommitted", disabled: session.worktreePath == null },
        { value: "pr", label: "Pull request", disabled: session.prNumber == null }
      ]}
    />
  )
}

export function ChangesExplorerPanel({
  session,
  connected,
  activePath,
  onOpenPath
}: {
  readonly session: Session
  readonly connected: boolean
  readonly activePath: string | null
  readonly onOpenPath: (path: string) => void
}) {
  const { review, adversarial } = useChangesReview(session, connected)
  return (
    <ChangedFilesExplorer
      files={review.files}
      fileDiffs={review.fileDiffs}
      omittedFiles={review.omittedFiles}
      diffLineLimit={review.diffLineLimit}
      drafts={review.drafts}
      reviewThreads={review.reviewThreads}
      review={review.source === "pr" ? adversarial.review : null}
      activePath={activePath}
      onSelectFile={onOpenPath}
    />
  )
}

export function ReviewTrayDock({
  session,
  connected,
  connectionMessage,
  connectionActionLabel,
  onConnectGithub
}: {
  readonly session: Session
  readonly connected: boolean
  readonly connectionMessage?: string
  readonly connectionActionLabel?: string
  readonly onConnectGithub: () => void
}) {
  const { review, adversarial, focused } = useChangesReview(session, connected)
  const paths = useMemo(() => new Set(review.files.map((file) => file.path)), [review.files])
  // Findings with no file only matter while the PR's changes are being reviewed.
  const reviewing = review.filter !== "all"
  if (focused) return null
  return (
    <ReviewSidebar
      drafts={review.drafts}
      source={review.source}
      connected={connected}
      connectionMessage={connectionMessage}
      connectionActionLabel={connectionActionLabel}
      review={reviewing ? adversarial.review : null}
      sentFindingIds={adversarial.sentFindingIds}
      routeTargetSession={session.title}
      paths={paths}
      onConnectGithub={onConnectGithub}
      onRemoveDraft={review.removeDraft}
      onFinishReview={review.finishReview}
      onSendFindingToAgent={adversarial.sendFindingToAgent}
    />
  )
}
