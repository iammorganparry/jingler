/**
 * Bridges the Code Review tab to the presentational `CodeReviewView`. Mounted
 * (keyed by session id) when the Code Review tab is active; owns its data via
 * `useReview` (both the PR diff and the worktree's uncommitted diff + reverts).
 */
import { useCallback, useState } from "react"
import type { CreateSessionInput, Session } from "@starbase/core"
import { CodeReviewView } from "@starbase/ui"
import { useReview } from "./use-review.js"
import { useAdversarialReview } from "./use-adversarial-review.js"
import { getConversationActor } from "./conversation-registry.js"

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

  // The set of Deslop sessions this pane has spawned that are still working.
  // State (not a ref) so the button's disabled-at-cap flag stays reactive.
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set())
  const atCap = inFlight.size >= maxConcurrentSubAgents

  const onDeslopFile = useCallback(
    async (path: string) => {
      // A worktree-less/old session has no origin repo to fork from, and a full
      // cap means the fan-out is already at its ceiling — either way, no-op.
      if (!session.repoPath || inFlight.size >= maxConcurrentSubAgents) return

      // A fresh session gets its OWN `sessionLock`, so its turn starts
      // immediately and can never queue behind this session's in-flight turn.
      const repoName = session.repoPath.split("/").filter(Boolean).pop() ?? session.repo
      const newSession = await onCreateSession({
        repoPath: session.repoPath,
        repoName,
        cli: session.cli,
        baseBranch: session.baseBranch ?? session.branch,
        title: `Deslop ${path.split("/").pop() ?? path}`
      })

      setInFlight((s) => new Set(s).add(newSession.id))

      // Drive the turn through the new session's own conversation actor (idle,
      // so nothing queues) — its work and any approval gates surface in that
      // session's Conversation tab, exactly like `sendFindingToAgent`.
      const actor = getConversationActor(newSession)
      actor.send({ type: "SEND", text: deslopPrompt(path) })

      // Free the cap slot once that session's turn has run and settled. We wait
      // to see it go busy first, so a subscription that fires before the turn
      // starts doesn't release the slot prematurely.
      let sawBusy = false
      const sub = actor.subscribe((snap) => {
        const busy = snap.context.runStartedAt !== null
        if (busy) {
          sawBusy = true
        } else if (sawBusy) {
          sub.unsubscribe()
          setInFlight((s) => {
            const next = new Set(s)
            next.delete(newSession.id)
            return next
          })
        }
      })
    },
    [session, inFlight.size, maxConcurrentSubAgents, onCreateSession]
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
