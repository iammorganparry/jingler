/**
 * Renderer hook backing the Pull Request tab. react-query owns the PR read
 * (`useQuery`) and the GitHub writes (`useMutation`, invalidating the read).
 * "Create pull request" and every other GitHub write go through the main-process
 * `GitHubApi` service (`rpc.github*`) with a short-lived App grant. The renderer
 * and sandboxed agent never receive installation credentials.
 * Routed review feedback still goes to the agent (a normal conversation turn),
 * so its work + any approval gates/questions surface in the Conversation tab.
 * Keeps `@jingler/ui`'s `PullRequestView` presentational.
 */
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PrMergeMethod, PullRequest, ReviewSubmitKind, Session, SessionPrStatus } from "@jingler/core"
import { activeCheckoutOf, checkoutFor } from "@jingler/core"
import { rpc } from "./rpc-client.js"
import { retryUnlessRateLimited } from "./github-poll.js"
import { getConversationActor } from "./conversation-registry.js"
import { markRouted, useRoutedEntries } from "./routed-store.js"

/** Format a submitted review as an instruction fed to the session's agent. */
const reviewPrompt = (kind: ReviewSubmitKind, body: string): string => {
  const verb =
    kind === "request-changes" ? "requested changes" : kind === "approve" ? "approved" : "commented"
  return `A reviewer ${verb} on this pull request:\n\n${body}\n\nPlease address this feedback.`
}

/** How often the PR tab polls the cheap PR state (2–3 GitHub requests); the full view reloads only when it changes. */
export const PR_REFRESH_MS = 30_000

/** What, when it changes, means the full PR view is out of date. */
export const prStateSignature = (status: SessionPrStatus | null | undefined): string | null =>
  status ? [status.state, status.checks, status.checkCounts?.passing, status.checkCounts?.total, status.updatedAt].join("|") : null

export const prKey = (sessionId: string, prNumber: number | null) =>
  ["github", "pr", sessionId, prNumber] as const

export interface PullRequestState {
  readonly pr: PullRequest | null
  readonly busy: boolean
  /** The message from a failed PR read, or null. */
  readonly loadError: string | null
  /** Re-run the PR read after a failure. */
  readonly retryLoad: () => void
  /** Re-read the PR state now (the view no longer polls on a timer). */
  readonly refresh: () => void
  /** A PR read is in flight. */
  readonly refreshing: boolean
  /** Merge the PR. Defaults to a merge commit; the side panel offers the choice. */
  readonly mergePr: (method?: PrMergeMethod) => Promise<void>
  /** A merge is in flight. */
  readonly merging: boolean
  /** The message from a failed merge API request, or null. */
  readonly mergeError: string | null
  /** Flip the linked draft PR to ready for review. */
  readonly markReady: () => Promise<void>
  /** A mark-ready is in flight. */
  readonly markingReady: boolean
  /** The message from a failed mark-ready API request, or null. */
  readonly markReadyError: string | null
  /** Merge the base into the PR's head (clears a `BEHIND` merge state). */
  readonly updateBranch: () => Promise<void>
  /** A branch update is in flight. */
  readonly updatingBranch: boolean
  /** The message from a failed update-branch API request, or null. */
  readonly updateBranchError: string | null
  readonly submitReview: (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => Promise<void>
  readonly sendEntryToAgent: (entryId: string) => Promise<void>
  /** Timeline entry ids already routed to the agent (their action stays "Sent"). */
  readonly sentEntryIds: ReadonlySet<string>
  /** Resolve / unresolve an inline review thread. */
  readonly resolveThread: (threadId: string, resolved: boolean) => Promise<void>
  /** Reply into an inline review thread (`commentId` = the REST databaseId). */
  readonly replyToThread: (commentId: number, body: string) => Promise<void>
  readonly openOnGithub: () => void
  /**
   * The PR's changed files, fetched only while merging is blocked by conflicts
   * — the closest list GitHub's REST API gives us to "the conflicting files"
   * without actually attempting the merge. Named in the side panel's
   * conflict-resolution prompt.
   */
  readonly conflictedFiles: ReadonlyArray<string>
  /** Post a conflict-resolution prompt into the session's chat, as a normal turn. */
  readonly resolveConflicts: (prompt: string) => void
}

/** The sweep's key for one PR's cheap state; sharing it means an open PR view costs no extra reads. */
export const prStateKey = (sessionId: string, checkoutId: string, prNumber: number | null) =>
  ["pr-state", sessionId, checkoutId, prNumber] as const

/**
 * Read the cheap PR state (shared with the App sweep) and invalidate `fullKey` only
 * when it changes. Nothing here polls on a timer: the sweep, window focus and the
 * Refresh button drive it, so an open PR tab no longer burns gh calls every 30s.
 */
export function useReloadOnPrChange(
  fullKey: ReadonlyArray<unknown>,
  sessionId: string,
  prNumber: number | null,
  checkoutId: string
): void {
  const qc = useQueryClient()
  const stateQuery = useQuery({
    queryKey: prStateKey(sessionId, checkoutId, prNumber),
    queryFn: () => rpc.githubPrState(sessionId, prNumber ?? undefined, checkoutId),
    enabled: prNumber != null,
    staleTime: PR_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: retryUnlessRateLimited
  })
  const signature = prStateSignature(stateQuery.data)
  const seen = useRef(signature)
  const keyRef = useRef(fullKey)
  keyRef.current = fullKey
  useEffect(() => {
    const previous = seen.current
    seen.current = signature
    if (previous !== null && signature !== null && previous !== signature) {
      void qc.invalidateQueries({ queryKey: keyRef.current })
    }
  }, [signature, qc])
}

export function usePullRequest(
  session: Session,
  opts: {
    connected: boolean
    /** The stack layer to show; defaults to the session's own PR. */
    prNumber?: number | null
  }
): PullRequestState {
  const qc = useQueryClient()
  const prNumber = opts.prNumber ?? activeCheckoutOf(session).prNumber
  // Same rule the main process uses (active first), so the state key matches the PR on screen.
  const checkoutId = checkoutFor(session, undefined, prNumber).id

  // The full view costs ~12 GitHub requests, so it is never polled: the shared cheap
  // state read reloads it only when something changed (new push, checks, comment).
  const query = useQuery({
    queryKey: prKey(session.id, prNumber),
    queryFn: () => rpc.githubPr(session.id, prNumber ?? undefined),
    staleTime: PR_REFRESH_MS,
    retry: retryUnlessRateLimited
  })
  useReloadOnPrChange(prKey(session.id, prNumber), session.id, prNumber, checkoutId)
  const refresh = useCallback(() => {
    const stateKey = prStateKey(session.id, checkoutId, prNumber)
    const before = prStateSignature(qc.getQueryData(stateKey))
    void qc.refetchQueries({ queryKey: stateKey, exact: true }).then(() => {
      const after = prStateSignature(qc.getQueryData(stateKey))
      // A changed signature already reloads the full view (useReloadOnPrChange); don't read it twice.
      if (before !== null && after !== null && before !== after) return
      void qc.invalidateQueries({ queryKey: prKey(session.id, prNumber) })
    })
  }, [qc, session.id, checkoutId, prNumber])

  // Route an instruction to the session's agent as a NORMAL conversation turn
  // (via the persistent actor), so its work + any approval gates / questions are
  // visible and answerable in the Conversation tab. A bare `rpc.agentRun` ran a
  // hidden turn whose gates rendered nowhere, so a gated command stalled forever.
  const routeToAgent = useCallback(
    (text: string) => {
      getConversationActor(session).send({ type: "SEND", text })
    },
    [session]
  )

  const reviewMutation = useMutation({
    mutationFn: (input: { body: string; kind: ReviewSubmitKind }) =>
      rpc.githubReview(session.id, input.kind, input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id, prNumber) })
  })

  // "Merge pull request" merges the linked PR through GitHub's API. On success the
  // PR read is invalidated so the header flips to "Merged" (and the archive
  // sweep, which polls the PR state, retires the session).
  const mergeMutation = useMutation({
    mutationFn: (method: PrMergeMethod) => rpc.githubMerge(session.id, method),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id, prNumber) })
  })
  // "Ready for review" flips a draft PR through GraphQL. On success the PR
  // read is invalidated so the header + side panel leave the Draft state.
  const markReadyMutation = useMutation({
    mutationFn: () => rpc.githubMarkReady(session.id),
    // Write the new state into the cache instead of invalidating: GitHub can serve
    // the stale draft right after the mutation, and the 10s poll reconciles later.
    onSuccess: () =>
      qc.setQueryData<PullRequest | null>(prKey(session.id, prNumber), (old) =>
        old ? { ...old, isDraft: false, state: old.state === "draft" ? "open" : old.state } : old
      )
  })
  const markReady = useCallback(
    () => markReadyMutation.mutateAsync().then(() => undefined),
    [markReadyMutation]
  )
  // "Update branch" merges the base into the PR head on GitHub, clearing a
  // `BEHIND` merge state. The re-read is what drops the blocker from the box.
  const updateBranchMutation = useMutation({
    mutationFn: () => rpc.githubUpdateBranch(session.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id, prNumber) })
  })
  const updateBranch = useCallback(
    () => updateBranchMutation.mutateAsync().then(() => undefined),
    [updateBranchMutation]
  )
  const mergePr = useCallback(
    (method: PrMergeMethod = "merge") => mergeMutation.mutateAsync(method).then(() => undefined),
    [mergeMutation]
  )

  const submitReview = useCallback(
    async (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => {
      if (input.routeToAgent && input.body.trim().length > 0) {
        routeToAgent(reviewPrompt(input.kind, input.body))
      }
      await reviewMutation.mutateAsync({ body: input.body, kind: input.kind })
    },
    [reviewMutation, routeToAgent]
  )

  // Resolve / unresolve an inline review thread, then re-read the PR so the
  // thread's badge and collapsed state follow GitHub.
  const resolveThreadMutation = useMutation({
    mutationFn: (input: { threadId: string; resolved: boolean }) =>
      rpc.githubResolveThread(session.id, input.threadId, input.resolved),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id, prNumber) })
  })
  const resolveThread = useCallback(
    (threadId: string, resolved: boolean) =>
      resolveThreadMutation.mutateAsync({ threadId, resolved }).then(() => undefined),
    [resolveThreadMutation]
  )

  // Reply into an inline review thread; the re-read brings the new comment back.
  const replyToThreadMutation = useMutation({
    mutationFn: (input: { commentId: number; body: string }) =>
      rpc.githubReplyToThread(session.id, input.commentId, input.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: prKey(session.id, prNumber) })
  })
  const replyToThread = useCallback(
    (commentId: number, body: string) =>
      replyToThreadMutation.mutateAsync({ commentId, body }).then(() => undefined),
    [replyToThreadMutation]
  )

  const pr = query.data ?? null
  // Only the REST file list names conflicting paths; fetch it only once the PR
  // read says merging is blocked by conflicts, never on every PR view.
  const hasConflicts = pr?.mergeBlockers.includes("Merge conflicts") ?? false
  const filesQuery = useQuery({
    queryKey: ["github", "conflicted-files", session.id, prNumber],
    queryFn: () => rpc.githubFiles(session.id, prNumber ?? undefined),
    enabled: hasConflicts
  })
  const conflictedFiles = useMemo(
    () => (hasConflicts ? (filesQuery.data ?? []).map((file) => file.path) : []),
    [hasConflicts, filesQuery.data]
  )
  const resolveConflicts = useCallback((prompt: string) => routeToAgent(prompt), [routeToAgent])
  const sentEntryIds = useRoutedEntries(session.id, prNumber)
  const sendEntryToAgent = useCallback(
    async (entryId: string) => {
      // An id is either a top-level timeline entry or a comment inside an inline
      // review thread — the latter carries its code reference on the thread.
      const item = pr?.timeline.find((t) => t.id === entryId)
      const thread = pr?.reviewThreads.find((t) => t.comments.some((c) => c.id === entryId))
      const comment = thread?.comments.find((c) => c.id === entryId)
      const found = item
        ? { author: item.author, body: item.body, path: item.path, line: item.line }
        : thread && comment
          ? {
              author: comment.author,
              body: comment.body,
              path: thread.path,
              // GitHub nulls the live anchor once the thread is outdated.
              line: thread.line ?? thread.originalLine
            }
          : null
      if (!found) return
      const ref = reviewFeedbackReference(found.path, found.line)
      routeToAgent(`Review feedback from @${found.author}${ref}:\n\n${found.body}\n\nPlease address this.`)
      if (prNumber !== null) markRouted(session.id, prNumber, entryId)
    },
    [pr, routeToAgent, session.id, prNumber]
  )

  const openOnGithub = useCallback(() => {
    if (pr?.url) void window.jingler.openExternal(pr.url)
  }, [pr])

  return {
    pr,
    busy: query.isPending,
    loadError: query.error ? ((query.error as { message?: string }).message ?? "Failed to load pull request") : null,
    retryLoad: () => void query.refetch(),
    refresh,
    refreshing: query.isFetching,
    mergePr,
    merging: mergeMutation.isPending,
    mergeError: mergeMutation.error
      ? ((mergeMutation.error as { message?: string }).message ?? "Failed to merge pull request")
      : null,
    markReady,
    markingReady: markReadyMutation.isPending,
    markReadyError: markReadyMutation.error
      ? ((markReadyMutation.error as { message?: string }).message ?? "Failed to mark pull request ready")
      : null,
    updateBranch,
    updatingBranch: updateBranchMutation.isPending,
    updateBranchError: updateBranchMutation.error
      ? ((updateBranchMutation.error as { message?: string }).message ?? "Failed to update the branch")
      : null,
    submitReview,
    sendEntryToAgent,
    sentEntryIds,
    resolveThread,
    replyToThread,
    openOnGithub,
    conflictedFiles,
    resolveConflicts
  }
}

function reviewFeedbackReference(path: string | null, line: number | null): string {
  if (!path) return ""
  return ` (on ${path}${line ? ` line ${line}` : ""})`
}
