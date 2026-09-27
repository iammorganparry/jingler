/**
 * Renderer hook backing the Code Review tab. Owns two diff sources — the PR
 * (GitHub's diff API) and the session worktree's uncommitted changes (a bounded
 * `git diff HEAD`, see `Sessions.diff`) — plus the "your review" draft tray. On
 * the local source it also drives reverts (line-range + whole-file) against the
 * worktree, refetching after each.
 */
import { useCallback, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { PrFileChange, PrReviewThread, Session } from "@jingler/core"
import type { ReviewOmittedFile } from "@jingler/ui"
import { diffBlocks, diffForPath } from "./review-diff-blocks.js"
import { rpc } from "./rpc-client.js"
import { getConversationActor } from "./conversation-registry.js"
import { prKey } from "./use-pull-request.js"
import {
  addReviewDraft,
  clearReviewDrafts,
  removeReviewDraft,
  setReviewFilter,
  setReviewViewed,
  useSessionReviewState,
  type ReviewDraft,
  type ReviewFilter
} from "./review-store.js"

export type { ReviewDraft, ReviewFilter } from "./review-store.js"

/** Which diff the review is showing. */
export type ReviewSource = "pr" | "local"

const draftLabel = (d: ReviewDraft): string =>
  `${d.path} ${d.endLine && d.endLine > d.line ? `L${d.line}-${d.endLine}` : `L${d.line}`}`

export interface ReviewState {
  /** The Explorer's filter; `source` is the diff it resolves to. */
  readonly filter: ReviewFilter
  readonly setFilter: (filter: ReviewFilter) => void
  readonly source: ReviewSource
  readonly setSource: (source: ReviewSource) => void
  readonly prAvailable: boolean
  readonly localAvailable: boolean
  readonly files: ReadonlyArray<PrFileChange>
  /** Every changed file's unified diff, in list order — for the continuous scroll view. */
  readonly fileDiffs: ReadonlyArray<{ readonly path: string; readonly diff: string }>
  /**
   * Local-source files listed with counts but whose patch main refused to
   * transport (over the per-file line/byte limit, or the whole-review cap).
   */
  readonly omittedFiles: ReadonlyArray<ReviewOmittedFile>
  /** The per-file line limit the omission explains, for the banner copy. */
  readonly diffLineLimit: number
  readonly activePath: string | null
  readonly drafts: ReadonlyArray<ReviewDraft>
  /**
   * The PR's existing inline review threads — GitHub's, and anything a bot left.
   * Empty on the local (uncommitted) source, which has no PR to carry them.
   * Feeds the file list's feedback count alongside findings and drafts.
   */
  readonly reviewThreads: ReadonlyArray<PrReviewThread>
  readonly busy: boolean
  readonly selectFile: (path: string) => void
  readonly toggleViewed: (path: string, viewed: boolean) => void
  readonly addDraft: (d: { path: string; line: number; endLine: number | null; body: string; routeToAgent: boolean }) => void
  readonly removeDraft: (id: string) => void
  readonly finishReview: (mode: "comment_only" | "send_to_agent") => void
  readonly revertLines: (range: { path: string; startLine: number; endLine: number }) => void
  readonly revertFile: (path: string) => void
}

const localKey = (sessionId: string) => ["local", "diff", sessionId] as const

const availableReviewSource = (
  source: ReviewSource,
  prAvailable: boolean,
  localAvailable: boolean
): ReviewSource => {
  if (source === "local" && !localAvailable && prAvailable) return "pr"
  if (source === "pr" && !prAvailable && localAvailable) return "local"
  return source
}

export function useReview(session: Session): ReviewState {
  const qc = useQueryClient()
  // Filter, drafts and viewed markers are shared across the Explorer, the Files
  // view and the review tray, so they live in the session's review store.
  const shared = useSessionReviewState(session.id, session.prNumber)
  const { filter, drafts } = shared
  const viewedPaths = shared.viewed
  const source: ReviewSource = filter === "pr" ? "pr" : "local"
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const toggleViewed = useCallback(
    (path: string, viewed: boolean) =>
      setReviewViewed(session.id, session.prNumber, path, viewed),
    [session.id, session.prNumber]
  )

  const prQuery = useQuery({
    queryKey: ["github", "review", session.id, session.prNumber],
    queryFn: async () => {
      // Settle independently: the file list and the diff are separate fetches
      // with separate permission surfaces, and a diff failure must not blank an
      // otherwise-complete review. (A single Promise.all rejection here showed
      // "No changes to review" even when 25 files had loaded.)
      const [filesResult, diffResult] = await Promise.allSettled([
        rpc.githubFiles(session.id),
        rpc.githubDiff(session.id)
      ])
      if (filesResult.status === "rejected") throw filesResult.reason
      return {
        files: filesResult.value,
        diff: diffResult.status === "fulfilled" ? diffResult.value : ""
      }
    }
  })

  // The PR's inline review threads, for the file list's feedback count.
  //
  // Deliberately a bare `useQuery` on the SAME key `usePullRequest` uses rather
  // than a call to that hook: it carries auto-detect-and-link side effects in its
  // queryFn, and running those from a second mounted pane would race the Pull
  // Request tab's. Sharing the key means react-query dedupes — when the PR tab
  // has already fetched, this resolves from cache and costs nothing.
  const threadsQuery = useQuery({
    queryKey: prKey(session.id, session.prNumber),
    queryFn: () => rpc.githubPr(session.id),
    enabled: session.prNumber != null
  })
  const localQuery = useQuery({
    queryKey: localKey(session.id),
    queryFn: () => rpc.sessionsDiff(session.id)
  })

  const prFiles = prQuery.data?.files ?? []
  const prDiff = prQuery.data?.diff ?? ""
  const localReview = localQuery.data
  const localDiff = localReview?.patch ?? ""
  // Counts come from Git numstat in main, never from walking the patch — an
  // omitted file still shows its size in the rail.
  const localFiles = useMemo<ReadonlyArray<PrFileChange>>(
    () =>
      (localReview?.files ?? []).map((file) => ({
        path: file.path,
        additions: file.added,
        deletions: file.removed,
        commentCount: 0,
        viewed: false
      })),
    [localReview]
  )

  const prAvailable = prFiles.length > 0
  const localAvailable = localFiles.length > 0

  // Fall back to whichever source actually has data.
  const effective = availableReviewSource(source, prAvailable, localAvailable)

  const sourceFiles = effective === "local" ? localFiles : prFiles
  // Overlay the reviewer's local "viewed" markers onto the source's file list.
  const files = useMemo(
    () => sourceFiles.map((f) => (viewedPaths.has(f.path) ? { ...f, viewed: true } : f)),
    [sourceFiles, viewedPaths]
  )
  const fullDiff = effective === "local" ? localDiff : prDiff
  const activePath = selectedPath ?? files[0]?.path ?? null
  // Every file's diff, from ONE split of the full diff — the continuous scroll
  // view renders them all stacked rather than one active file at a time.
  const blocks = useMemo(() => diffBlocks(fullDiff), [fullDiff])
  const fileDiffs = useMemo(
    () => files.map((f) => ({ path: f.path, diff: diffForPath(blocks, f.path) })),
    [files, blocks]
  )
  const omittedFiles = useMemo<ReadonlyArray<ReviewOmittedFile>>(
    () =>
      effective === "local"
        ? (localReview?.files ?? []).flatMap((file) =>
            file.omitted === null
              ? []
              : [{ path: file.path, added: file.added, removed: file.removed, reason: file.omitted }]
          )
        : [],
    [effective, localReview]
  )

  const setFilter = useCallback(
    (next: ReviewFilter) => {
      setReviewFilter(session.id, session.prNumber, next)
      setSelectedPath(null) // reset to the first file of the new source
    },
    [session.id, session.prNumber]
  )
  const setSource = useCallback((s: ReviewSource) => setFilter(s), [setFilter])

  const addDraft = useCallback(
    (d: { path: string; line: number; endLine: number | null; body: string; routeToAgent: boolean }) =>
      addReviewDraft(session.id, session.prNumber, d),
    [session.id, session.prNumber]
  )

  const removeDraft = useCallback(
    (id: string) => removeReviewDraft(session.id, session.prNumber, id),
    [session.id, session.prNumber]
  )

  const finishReview = useCallback(
    (mode: "comment_only" | "send_to_agent") => {
      const current = drafts
      if (current.length === 0) return
      const summary = current.map((d) => `- ${draftLabel(d)}: ${d.body}`).join("\n")
      if (mode === "send_to_agent") {
        // Route through the session's persistent conversation actor (a SEND
        // event) — the SAME path the composer uses — so the turn is appended to
        // the transcript and its response streams into the conversation pane.
        // Calling `rpc.agentRun` directly (with a throwaway event callback) ran a
        // parallel agent whose output never reached this conversation.
        getConversationActor(session).send({
          type: "SEND",
          text: `Please address these code review comments:\n\n${summary}`
        })
      } else {
        // Post as a review carrying INLINE comments, not one flattened top-level
        // blob: a draft written on a line has to come back from GitHub on that
        // same line, or Jingler and the PR disagree after any refresh.
        //
        // `line` is the range END (GitHub's orientation, see `ReviewComment`),
        // which is why `endLine` maps to it and `line` becomes `startLine`.
        void rpc
          .githubSubmitReview(
            session.id,
            current.map((d) => ({
              path: d.path,
              line: d.endLine !== null && d.endLine > d.line ? d.endLine : d.line,
              startLine: d.endLine !== null && d.endLine > d.line ? d.line : null,
              body: d.body
            }))
          )
          // The new threads only exist on GitHub until the PR is refetched, and
          // this key is shared with the Pull Request tab — so both panes pick
          // them up from one invalidation.
          .then(() =>
            qc.invalidateQueries({
              queryKey: prKey(session.id, session.prNumber)
            })
          )
          .catch(() => {})
      }
      clearReviewDrafts(session.id, session.prNumber)
    },
    [drafts, session, qc]
  )

  const refetchLocal = () => qc.invalidateQueries({ queryKey: localKey(session.id) })
  const revertLines = useCallback(
    (range: { path: string; startLine: number; endLine: number }) => {
      void rpc
        .workspaceRevertLines(session.id, range.path, range.startLine, range.endLine)
        .then(refetchLocal)
        .catch(() => {})
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  )
  const revertFile = useCallback(
    (path: string) => {
      void rpc.workspaceRevertFile(session.id, path).then(refetchLocal).catch(() => {})
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  )

  return {
    filter,
    setFilter,
    source: effective,
    setSource,
    prAvailable,
    localAvailable,
    files,
    fileDiffs,
    omittedFiles,
    diffLineLimit: localReview?.lineLimit ?? 0,
    activePath,
    drafts,
    // Threads belong to the PR. On the local (uncommitted) diff they'd anchor to
    // lines that don't correspond, so the source decides whether they exist.
    reviewThreads: effective === "pr" ? (threadsQuery.data?.reviewThreads ?? []) : [],
    busy: prQuery.isPending || localQuery.isPending,
    selectFile: setSelectedPath,
    toggleViewed,
    addDraft,
    removeDraft,
    finishReview,
    revertLines,
    revertFile
  }
}
