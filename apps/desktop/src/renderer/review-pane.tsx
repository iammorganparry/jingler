/**
 * Bridges the Code Review tab to the presentational `CodeReviewView`. Mounted
 * (keyed by session id) when the Code Review tab is active; owns its data via
 * `useReview` (both the PR diff and the worktree's uncommitted diff + reverts).
 */
import { useCallback, useSyncExternalStore } from "react"
import type { CreateSessionInput, Session } from "@starbase/core"
import { CodeReviewView } from "@starbase/ui"
import { useReview } from "./use-review.js"
import { useAdversarialReview } from "./use-adversarial-review.js"
import { getConversationActor } from "./conversation-registry.js"
import { deslopTracker } from "./deslop-tracker.js"

/** The instruction handed to a fresh session's agent to clean up one file. */
const deslopPrompt = (path: string): string =>
  `Refactor \`${path}\` to remove "slop": dead code, needless indirection, and ` +
  `copy-paste. Pull repeated logic into shared helpers so it's DRY, tighten ` +
  `names, and simplify control flow — WITHOUT changing behaviour. If the file ` +
  `is already clean, say so rather than churning it.`

export function ReviewPane({
  session,
  connected,
  onConnectGithub,
  onCreateSession,
  maxConcurrentSubAgents
}: {
  session: Session
  connected: boolean
  onConnectGithub: () => void
  /** Create a brand-new session (dispatches SESSION_CREATED) and return it. */
  onCreateSession: (input: CreateSessionInput) => Promise<Session>
  /** How many Deslop sub-agent sessions may run at once. */
  maxConcurrentSubAgents: number
}) {
  const review = useReview(session)
  // Read-only here: the adversarial review is *run* from the Pull Request tab.
  // This tab renders whatever the last run produced, anchored to the diff.
  const adversarial = useAdversarialReview(session, { connected })

  // The in-flight count is a MODULE-level ceiling, not pane state: the deslop
  // sessions outlive this pane (which unmounts on every tab/session switch), so a
  // per-pane counter would reset and let the cap be blown past. See deslop-tracker.
  const inFlightCount = useSyncExternalStore(deslopTracker.subscribe, deslopTracker.count)
  const atCap = inFlightCount >= maxConcurrentSubAgents

  const onDeslopFile = useCallback(
    async (path: string) => {
      // A worktree-less/old session has no origin repo to fork from, and a full
      // cap means the fan-out is already at its ceiling — either way, no-op.
      if (!session.repoPath || deslopTracker.count() >= maxConcurrentSubAgents) return

      // A fresh session gets its OWN `sessionLock`, so its turn starts
      // immediately and can never queue behind this session's in-flight turn.
      //
      // Fork from this session's OWN branch, not its base: the file's reviewed
      // changes (PR commits) live on `session.branch`. Forking from the base
      // (main) would hand the agent a copy without those changes — or, for a file
      // the PR adds, no file at all. (Uncommitted worktree changes still aren't
      // carried; a commit is the honest boundary for what a fresh worktree sees.)
      const repoName = session.repoPath.split("/").filter(Boolean).pop() ?? session.repo
      const newSession = await onCreateSession({
        repoPath: session.repoPath,
        repoName,
        cli: session.cli,
        baseBranch: session.branch,
        title: `Deslop ${path.split("/").pop() ?? path}`
      })

      deslopTracker.add(newSession.id)

      // Drive the turn through the new session's own conversation actor (idle,
      // so nothing queues) — its work and any approval gates surface in that
      // session's Conversation tab, exactly like `sendFindingToAgent`.
      const actor = getConversationActor(newSession)
      actor.send({ type: "SEND", text: deslopPrompt(path) })

      // Free the cap slot once that session's turn has run and settled. We wait
      // to see it go busy first, so a subscription that fires before the turn
      // starts doesn't release the slot prematurely. The subscription lives in
      // the module-level actor, so it settles even if this pane has unmounted.
      let sawBusy = false
      const sub = actor.subscribe((snap) => {
        const busy = snap.context.runStartedAt !== null
        if (busy) {
          sawBusy = true
        } else if (sawBusy) {
          sub.unsubscribe()
          deslopTracker.remove(newSession.id)
        }
      })
    },
    [session, maxConcurrentSubAgents, onCreateSession]
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
      onDeslopFile={session.repoPath ? onDeslopFile : undefined}
      deslopAtCap={atCap}
    />
  )
}
