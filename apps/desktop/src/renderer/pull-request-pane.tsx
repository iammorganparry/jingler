/**
 * Bridges the Pull Request tab to the presentational `PullRequestView`. Mounted
 * (keyed by session id) when the PR tab is active; owns its data via
 * `usePullRequest`.
 */
import type { Project, Session } from "@jingler/core"
import { workspaceModeOf } from "@jingler/core"
import { PullRequestView } from "@jingler/ui"
import { CheckoutChecks } from "./checkout-checks.js"
import { usePullRequest } from "./use-pull-request.js"
import { useAdversarialReview } from "./use-adversarial-review.js"
import { usePublish } from "./use-publish.js"
import { usePrStack } from "./use-pr-stack.js"
import { useWorkspaceWorkflow } from "./use-workspace-workflow.js"

export function PullRequestPane({
  session,
  project,
  connected,
  autoDetect,
  viewerLogin,
  connectionMessage,
  connectionActionLabel,
  onConnectGithub,
  onPrLinked,
  onPublishCheckpoint,
  onOpenFiles,
  onSession
}: {
  session: Session
  project?: Project
  connected: boolean
  autoDetect: boolean
  /** The authenticated GitHub login (to disable approving your own PR). */
  viewerLogin?: string | null
  connectionMessage?: string
  connectionActionLabel?: string
  onConnectGithub: () => void
  onPrLinked: (sessionId: string, prNumber: number) => void
  onPublishCheckpoint: (sessionId: string, checkpoint: NonNullable<Session["publish"]>) => void
  onOpenFiles: () => void
  /** Publishes a workspace lifecycle update (retry/skip setup) back to the session list. */
  onSession: (session: Session) => void
}) {
  const stack = usePrStack(session, connected)
  // Session-level writes (merge, review, close…) act on the session's own PR, so a lower layer is read-only.
  const viewingLowerLayer = stack.selected !== null && stack.selected !== session.prNumber
  const {
    pr,
    busy,
    loadError,
    retryLoad,
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
    openOnGithub,
    conflictedFiles,
    resolveConflicts
  } = usePullRequest(session, { connected, autoDetect, onPrLinked, prNumber: stack.selected })
  const publish = usePublish(session, onPrLinked, onPublishCheckpoint)
  const workflow = useWorkspaceWorkflow(session, project, onSession)

  const {
    review,
    running: reviewRunning,
    phase: reviewPhase,
    startedAt: reviewStartedAt,
    error: reviewError,
    runReview,
    sendFindingToAgent,
    sentFindingIds,
    dismissedFindingIds,
    dismissFinding
  } = useAdversarialReview(session, { connected })

  return (
    <div className="flex h-full min-h-0 flex-col">
    <CheckoutChecks session={session} />
    <PullRequestView
      pr={pr}
      connected={connected}
      connectionMessage={connectionMessage}
      connectionActionLabel={connectionActionLabel}
      busy={busy}
      loadError={loadError}
      onRetryLoad={retryLoad}
      viewerLogin={viewerLogin}
      publish={publish.checkpoint}
      publishing={publish.publishing}
      branch={session.branch}
      baseBranch={session.baseBranch ?? pr?.baseRefName}
      prs={session.prs}
      stack={stack.nav}
      readOnly={viewingLowerLayer}
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
      onOpenFiles={onOpenFiles}
      conflictedFiles={conflictedFiles}
      onResolveConflicts={resolveConflicts}
      review={{
        review,
        running: reviewRunning,
        phase: reviewPhase,
        startedAt: reviewStartedAt,
        error: reviewError,
        onRun: runReview,
        onSendFindingToAgent: sendFindingToAgent,
        sentFindingIds,
        dismissedFindingIds,
        onDismissFinding: dismissFinding
      }}
      workflow={{
        lifecycle: workflow.lifecycle,
        commands: workflow.commands,
        runs: workflow.runs,
        error: workflow.error,
        onRetrySetup: workflow.retrySetup,
        onSkipSetup: workflow.skipSetup,
        onStartRun: workflow.startRun,
        onStopRun: workflow.stopRun,
        onArchiveWithoutCleanup: workflow.archiveWithoutCleanup
      }}
    />
    </div>
  )
}
