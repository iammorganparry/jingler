/**
 * The desktop half of changes review: binds the session's review data (PR and
 * uncommitted diffs, drafts, viewed markers, adversarial findings) to the three
 * places it now renders — the Explorer's changed-files filter, the Files view's
 * review diff, and the review tray beside the panes.
 */
import { useCallback, useMemo } from "react"
import { useSelector } from "@xstate/react"
import type { Session, SubagentFleetNode } from "@jingler/core"
import { activeCheckoutOf, checkoutsOf, hasNoRepo, workspaceModeOf } from "@jingler/core"
import type { AgentTreeChanges } from "@jingler/ui"
import { ChangedFilesExplorer, EmptyState, SubagentScopeBar, ReviewSidebar, checkoutLabel, reviewTurnsOf } from "@jingler/ui"
import { getConversationActor } from "./conversation-registry.js"
import {
  setReviewFilter,
  setReviewFocused,
  setReviewPrLayer,
  setReviewTurn,
  useReviewFocused,
  useSessionReviewState
} from "./review-store.js"
import { reviewCommentsContext } from "./review-references.js"
import { useAdversarialReview } from "./use-adversarial-review.js"
import { useAgentTrees } from "./use-agent-trees.js"
import { useReview } from "./use-review.js"
import { useViewedChild } from "./subagent-tab-store.js"
import { scopeBarState } from "./subagent-scope.js"
import { useSubagentView } from "./use-subagent-view.js"

/** The instruction handed to the session's agent to clean up one file. */
const deslopPrompt = (path: string): string =>
  `Refactor \`${path}\` to remove "slop": dead code, needless indirection, and ` +
  `copy-paste. Pull repeated logic into shared helpers so it's DRY, tighten ` +
  `names, and simplify control flow — WITHOUT changing behaviour. If the file ` +
  `is already clean, say so rather than churning it.`

export function useChangesReview(session: Session, connected: boolean, checkoutId?: string) {
  const review = useReview(session, checkoutId)
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
  // "Send to agent" from the comment box: the same conversation path the review
  // tray uses, for one comment, without collecting it as a draft first.
  const fileDiffs = review.fileDiffs
  const sendComment = useCallback(
    (comment: { path: string; line: number; endLine: number | null; body: string }) => {
      const lines =
        comment.endLine !== null && comment.endLine > comment.line
          ? `L${comment.line}-${comment.endLine}`
          : `L${comment.line}`
      getConversationActor(session).send({
        type: "SEND",
        text: `Please address this code review comment on \`${comment.path}\` ${lines}:\n\n${comment.body}`,
        // The referenced lines themselves, as the composer's code references carry them.
        agentContext: reviewCommentsContext(
          (path) => fileDiffs.find((entry) => entry.path === path)?.diff ?? "",
          [comment]
        )
      })
    },
    [fileDiffs, session]
  )
  const focused = useReviewFocused()
  const toggleFocus = useCallback(() => setReviewFocused(!focused), [focused])

  return {
    review,
    adversarial,
    deslopFile,
    sendComment,
    focused,
    toggleFocus,
    revertFile: worktree ? review.revertFile : undefined
  }
}

/** What the Changes rail button does: show this session's changes in the Explorer. */
export const revealSessionChanges = (session: Session): void =>
  setReviewFilter(session.id, session.prNumber, session.prNumber != null ? "pr" : "local")

/** The agent turns that changed files, and which one the Changes list is narrowed to. */
export function useReviewTurns(session: Session) {
  // Memoised: getConversationActor pushes the session into the actor on every call.
  const actor = useMemo(() => getConversationActor(session), [session.id, session.activeChatId]) // eslint-disable-line react-hooks/exhaustive-deps
  const messages = useSelector(actor, (snapshot) => snapshot.context.messages)
  const turns = useMemo(() => reviewTurnsOf(messages), [messages])
  const { turnId } = useSessionReviewState(session.id, session.prNumber)
  const turn = turns.find((candidate) => candidate.id === turnId) ?? null
  const setTurn = useCallback(
    (next: string | null) => setReviewTurn(session.id, session.prNumber, next),
    [session.id, session.prNumber]
  )
  return { turns, turn, setTurn }
}

function ViewedChildScopeBar({
  viewed,
  agentTrees,
  onShowAll
}: {
  readonly viewed: SubagentFleetNode
  readonly agentTrees: ReadonlyArray<AgentTreeChanges>
  readonly onShowAll: () => void
}) {
  const fileCount = agentTrees.find((tree) => tree.agentId === viewed.subagentId)?.files.length ?? 0
  return (
    <SubagentScopeBar
      agent={viewed.agent}
      branch={viewed.workspace?.branch ?? null}
      prNumber={viewed.prNumber}
      state={scopeBarState(viewed, fileCount)}
      baseRef={viewed.workspace?.baseRef ?? null}
      onShowAll={onShowAll}
    />
  )
}

function CheckoutChangesList({
  session,
  connected,
  checkoutId,
  activePath,
  onOpenPath
}: {
  readonly session: Session
  readonly connected: boolean
  readonly checkoutId?: string
  readonly activePath: string | null
  readonly onOpenPath: (path: string) => void
}) {
  const { review, adversarial, revertFile } = useChangesReview(session, connected, checkoutId)
  const { turns, turn, setTurn } = useReviewTurns(session)
  const { prLayer } = useSessionReviewState(session.id, session.prNumber)
  const selectLayer = useCallback(
    (next: number) => {
      setReviewPrLayer(session.id, session.prNumber, next)
      setReviewFilter(session.id, session.prNumber, "pr")
    },
    [session.id, session.prNumber]
  )
  // The turn filter and Discard belong to the active checkout only.
  const active = checkoutId === undefined
  const agentTrees = useAgentTrees(session, review.files, active && review.source === "local")
  const { changesScope, setChangesScope } = useSubagentView(session.activeChatId)
  const viewed = useViewedChild(session.id, session.activeChatId)
  const scoped = active && viewed !== null && changesScope === viewed.subagentId
  return (
    <>
    {scoped && <ViewedChildScopeBar viewed={viewed} agentTrees={agentTrees} onShowAll={() => setChangesScope("all")} />}
    <ChangedFilesExplorer
      turns={active ? turns : []}
      turnId={active ? (turn?.id ?? null) : null}
      onTurnChange={setTurn}
      prLayers={active ? (session.prs ?? []) : []}
      prNumber={prLayer ?? session.prNumber}
      onPrNumberChange={selectLayer}
      files={review.files}
      agentTrees={agentTrees}
      agentScope={changesScope}
      onAgentScopeChange={setChangesScope}
      fileDiffs={review.fileDiffs}
      omittedFiles={review.omittedFiles}
      diffLineLimit={review.diffLineLimit}
      drafts={review.drafts}
      reviewThreads={review.reviewThreads}
      // Adversarial findings belong to the active checkout's PR only.
      review={review.source === "pr" && checkoutId === undefined ? adversarial.review : null}
      activePath={activePath}
      onSelectFile={onOpenPath}
      onDiscardFile={active && review.source === "local" ? revertFile : undefined}
      loading={review.loading}
      error={review.error}
      onRetry={review.retry}
    />
    </>
  )
}

/** Changes for the session; a multi-repo session lists one group per checkout. */
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
  const checkouts = checkoutsOf(session)
  // An Auto session with nothing attached yet has no repo to diff against.
  if (checkouts.length < 2 && hasNoRepo(activeCheckoutOf(session))) {
    return <EmptyState className="py-6" title={<span data-testid="changes-no-repo">No repo</span>} description="The agent hasn't attached a repo yet." />
  }
  if (checkouts.length < 2) {
    return (
      <CheckoutChangesList
        session={session}
        connected={connected}
        activePath={activePath}
        onOpenPath={onOpenPath}
      />
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {checkouts.map((checkout) => (
        <section
          key={checkout.id}
          data-testid={`changes-checkout-${checkout.id}`}
          className="flex min-h-[10rem] flex-1 flex-col border-b border-line"
        >
          <h3 className="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-wide text-dim">
            {checkoutLabel(checkout)}
          </h3>
          <CheckoutChangesList
            session={session}
            connected={connected}
            checkoutId={checkout.id}
            activePath={activePath}
            onOpenPath={onOpenPath}
          />
        </section>
      ))}
    </div>
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
      dismissedFindingIds={adversarial.dismissedFindingIds}
      onDismissFinding={adversarial.dismissFinding}
      routeTargetSession={session.title}
      paths={paths}
      onConnectGithub={onConnectGithub}
      onRemoveDraft={review.removeDraft}
      onFinishReview={review.finishReview}
      onSendFindingToAgent={adversarial.sendFindingToAgent}
    />
  )
}
