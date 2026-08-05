/**
 * Bridges the Pull Request tab to the presentational `PullRequestView`. Mounted
 * (keyed by session id) when the PR tab is active; owns its data via
 * `usePullRequest`.
 */
import type { Session } from "@jingler/core"
import { workspaceModeOf } from "@jingler/core"
import { PullRequestView } from "@jingler/ui"
import { usePullRequest } from "./use-pull-request.js"
import { useAdversarialReview } from "./use-adversarial-review.js"
import { usePublish } from "./use-publish.js"

export function PullRequestPane({
  session,
  connected,
  autoDetect,
  viewerLogin,
  connectionMessage,
  connectionActionLabel,
  onConnectGithub,
  onPrLinked,
  onPublishCheckpoint
}: {
  session: Session
  connected: boolean
  autoDetect: boolean
  /** The authenticated GitHub login (to disable approving your own PR). */
  viewerLogin?: string | null
  connectionMessage?: string
  connectionActionLabel?: string
  onConnectGithub: () => void
  onPrLinked: (sessionId: string, prNumber: number) => void
  onPublishCheckpoint: (sessionId: string, checkpoint: NonNullable<Session["publish"]>) => void
}) {
  const {
    pr,
    busy,
    mergePr,
    merging,
    mergeError,
    markReady,
    markingReady,
    markReadyError,
    updateBranch,
    updatingBranch,
    updateBranchError,
    submitReview,
    sendEntryToAgent,
    sentEntryIds,
    resolveThread,
    replyToThread,
    openOnGithub
  } = usePullRequest(session, { connected, autoDetect, onPrLinked })
  const publish = usePublish(session, onPrLinked, onPublishCheckpoint)

  const {
    review,
    running: reviewRunning,
    phase: reviewPhase,
    startedAt: reviewStartedAt,
    error: reviewError,
    runReview,
    sendFindingToAgent,
    sentFindingIds
  } = useAdversarialReview(session, { connected })

  return (
    <PullRequestView
      pr={pr}
      connected={connected}
      connectionMessage={connectionMessage}
      connectionActionLabel={connectionActionLabel}
      busy={busy}
      viewerLogin={viewerLogin}
      publish={publish.checkpoint}
      publishing={publish.publishing}
      branch={session.branch}
      sessionTitle={session.title}
      onCreatePr={
        workspaceModeOf(session) === "worktree" ? publish.publish : undefined
      }
      onRetryPublish={publish.retry}
      onMerge={mergePr}
      merging={merging}
      mergeError={mergeError}
      onMarkReady={markReady}
      markingReady={markingReady}
      markReadyError={markReadyError}
      onUpdateBranch={updateBranch}
      updatingBranch={updatingBranch}
      updateBranchError={updateBranchError}
      onConnectGithub={onConnectGithub}
      onSubmitReview={submitReview}
      onSendEntryToAgent={sendEntryToAgent}
      sentEntryIds={sentEntryIds}
      onResolveThread={resolveThread}
      onReplyToThread={replyToThread}
      onOpenOnGithub={openOnGithub}
      review={{
        review,
        running: reviewRunning,
        phase: reviewPhase,
        startedAt: reviewStartedAt,
        error: reviewError,
        onRun: runReview,
        onSendFindingToAgent: sendFindingToAgent,
        sentFindingIds
      }}
    />
  )
}
