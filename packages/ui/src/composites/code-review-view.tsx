import { useCallback, useEffect, useMemo, useRef } from "react"
import type { AdversarialReview, PrFileChange, PrReviewThread, ReviewFinding } from "@jingler/core"
import {
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight
} from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { ResizeHandle, useResizableWidth } from "../components/resizable.js"
import { cn } from "../lib/cn.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { feedbackCounts } from "../lib/review-feedback.js"
import { ReviewFileRail } from "./review-file-rail.js"
import { ReviewFileSection } from "./review-file-section.js"
import { ReviewFindingRow, rankFindings } from "./review-findings.js"
import { ReviewTray, type ReviewDraft } from "./review-tray.js"
import { filterReviewFiles } from "./review-file-filter.js"
import { useCodeReviewView } from "./use-code-review-view.js"

/** Which diff the Code Review is showing — the PR, or the worktree's own changes. */
export type ReviewSource = "pr" | "local"

/**
 * Code needs enough room for the two line-number gutters plus a useful run of
 * source. If the saved rail widths would leave less than this, both rails become
 * sheets instead of squeezing the diff.
 */
const MIN_READABLE_DIFF_WIDTH = 560
const REDOCK_DIFF_WIDTH = 600

export interface CodeReviewViewProps {
  files: readonly PrFileChange[]
  /**
   * The PR's unresolved inline review threads. Counted into each file's feedback
   * marker alongside findings and drafts — a file a human commented on should
   * flag as needing attention just as loudly as one the reviewer flagged.
   */
  reviewThreads?: readonly PrReviewThread[]
  /** The file currently in view (highlighted in the list; tracked by scroll). */
  activePath: string | null
  /** Every changed file's unified diff, in list order — rendered as one continuous scroll. */
  fileDiffs: readonly { readonly path: string; readonly diff: string }[]
  drafts: readonly ReviewDraft[]
  routeTargetSession: string | null
  connected: boolean
  /** Live installation-access explanation when GitHub posting is unavailable. */
  connectionMessage?: string
  connectionActionLabel?: string
  /** Which source is shown, and whether each is available. */
  source: ReviewSource
  prAvailable: boolean
  localAvailable: boolean
  onSetSource: (source: ReviewSource) => void
  onSelectFile: (path: string) => void
  onToggleViewed: (path: string, viewed: boolean) => void
  onAddDraft: (draft: {
    path: string
    line: number
    endLine: number | null
    body: string
    routeToAgent: boolean
  }) => void
  onRemoveDraft: (id: string) => void
  onFinishReview: (mode: "comment_only" | "send_to_agent") => void
  onConnectGithub?: () => void
  /** Revert the selected lines — wired only for the uncommitted (local) source. */
  onRevertLines?: (range: { path: string; startLine: number; endLine: number }) => void
  /** Revert a whole file's uncommitted changes — the local source only. */
  onRevertFile?: (path: string) => void
  /**
   * The last adversarial review. Its findings render anchored to their file
   * (above that file's diff), with anything unanchored — or pointing at a file
   * not in this diff — collected into a "General" group at the top.
   */
  review?: AdversarialReview | null
  onSendFindingToAgent?: (findingId: string) => void
  /** Ids of findings already sent to the agent — their action stays "Sent". */
  sentFindingIds?: ReadonlySet<string>
  /**
   * Hand a file to this session's agent for a "Deslop" cleanup pass (a normal
   * turn on the session's own worktree). Absent hides the per-file button.
   */
  onDeslopFile?: (path: string) => void
}

/**
 * The Files-changed / Code Review tab — a file list, a selectable diff, and the
 * review tray. Reviewers select line ranges in the diff to draft inline comments,
 * then finish the review (comment-only, or routed to the session's agent).
 */
export function CodeReviewView({
  files: allFiles,
  reviewThreads = [],
  activePath,
  fileDiffs,
  drafts,
  routeTargetSession,
  connected,
  connectionMessage,
  connectionActionLabel = "Connect GitHub",
  source,
  prAvailable,
  localAvailable,
  onSetSource,
  onSelectFile,
  onToggleViewed,
  onAddDraft,
  onRemoveDraft,
  onFinishReview,
  onConnectGithub,
  onRevertLines,
  onRevertFile,
  review,
  onSendFindingToAgent,
  sentFindingIds,
  onDeslopFile
}: CodeReviewViewProps) {
  const isLocal = source === "local"
  const controls = useCodeReviewView()

  // Findings are shown against the PR they were argued about. On the local
  // (uncommitted) diff they'd be anchored to the wrong thing entirely.
  const activeReview = source === "pr" ? (review ?? null) : null

  const feedback = useMemo(
    () =>
      feedbackCounts({
        files: allFiles,
        findings: activeReview?.findings ?? [],
        drafts,
        threads: reviewThreads
      }),
    [allFiles, activeReview, drafts, reviewThreads]
  )

  /**
   * Search, type, and feedback filters apply to the file rail and stacked diff
   * together. A control can never claim a file is hidden while its code remains
   * in the middle pane.
   *
   * Filtered ONCE, here, and everything downstream reads `files`: the list, the
   * +/− and viewed totals, and the stacked diff scroller. Filtering only the
   * list would leave the scroller showing files the list denies exist.
   */
  const files = useMemo(
    () =>
      filterReviewFiles(allFiles, {
        query: controls.query,
        kind: controls.kind,
        feedbackPaths: controls.feedbackOnly ? new Set(feedback.byPath.keys()) : undefined
      }),
    [allFiles, controls.query, controls.kind, controls.feedbackOnly, feedback]
  )
  const filtersActive =
    controls.query.trim().length > 0 ||
    controls.kind !== "all" ||
    controls.feedbackOnly

  // Turning the filter on while a now-hidden file is active would leave the
  // list with no selection and the scroll-spy chasing a section that no longer
  // renders. Hand focus to the first visible file instead.
  useEffect(() => {
    if (files.length === 0) return
    if (activePath !== null && files.some((f) => f.path === activePath)) return
    onSelectFile(files[0]!.path)
  }, [files, activePath, onSelectFile])

  // A filter you can't turn off is a trap: if the last piece of feedback is
  // resolved while it's on, the view empties and the only way back is a control
  // that now looks inert. Force it off the moment there's nothing to filter to.
  useEffect(() => {
    if (controls.feedbackOnly && !feedback.any) controls.clearFeedback()
  }, [controls.feedbackOnly, controls.clearFeedback, feedback.any])

  const added = files.reduce((sum, f) => sum + f.additions, 0)
  const removed = files.reduce((sum, f) => sum + f.deletions, 0)
  const viewed = files.filter((f) => f.viewed).length

  const diffByPath = useMemo(
    () => new Map(fileDiffs.map((d) => [d.path, d.diff])),
    [fileDiffs]
  )

  /**
   * Roughly how tall each file's rendered diff will be, for the spacer a
   * not-yet-mounted section leaves behind (see `DeferredSection`).
   *
   * Newlines rather than a real parse: this is a placeholder height that is
   * replaced by a measurement the first time the section mounts, so precision
   * buys nothing — and parsing every file's diff up front to compute it would
   * reintroduce a chunk of the work the deferral exists to avoid. `ROW_HEIGHT`
   * tracks `DiffLine`'s `text-[12px] leading-[1.85]`.
   */
  const heightByPath = useMemo(() => {
    const ROW_HEIGHT = 22.2
    const out = new Map<string, number>()
    for (const { path, diff } of fileDiffs) {
      let rows = 0
      for (let i = 0; i < diff.length; i++) if (diff.charCodeAt(i) === 10) rows++
      out.set(path, Math.max(ROW_HEIGHT, rows * ROW_HEIGHT))
    }
    return out
  }, [fileDiffs])

  /**
   * Findings grouped by file, plus the ones that belong nowhere in particular.
   *
   * A finding whose `path` is absent from this diff goes to `general` rather
   * than being dropped — the reviewer may name a file it read for context, and
   * silently swallowing its verdict is worse than showing it unanchored.
   *
   * Keyed off `allFiles`, NOT the filtered `files`: "general" means "no file in
   * this diff owns it", which is a fact about the DIFF. Resolving it against the
   * filtered list would move a hidden file's findings into General the moment
   * you turned the filter on — the same findings, silently reclassified by a
   * view control.
   */
  const { byFile, general } = useMemo(() => {
    const findings = rankFindings(activeReview?.findings ?? [])
    const paths = new Set(allFiles.map((f) => f.path))
    const byFile = new Map<string, ReviewFinding[]>()
    const general: ReviewFinding[] = []
    for (const finding of findings) {
      if (finding.path !== null && paths.has(finding.path)) {
        byFile.set(finding.path, [...(byFile.get(finding.path) ?? []), finding])
      } else {
        general.push(finding)
      }
    }
    return { byFile, general }
  }, [activeReview, allFiles])


  // The continuous diff scroller and one anchor per file section, so scrolling can
  // track the current file and clicking a file can jump to its section.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const rafRef = useRef<number | null>(null)
  // Cancel any pending scroll-spy frame when the tab unmounts.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
  }, [])

  // One stable ref callback per file path (cached), so re-renders don't thrash
  // `sectionRefs` via React's detach-old/attach-new ref protocol.
  const refCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map())
  const setSectionRef = useCallback((path: string) => {
    let cb = refCallbacks.current.get(path)
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) sectionRefs.current.set(path, el)
        else sectionRefs.current.delete(path)
      }
      refCallbacks.current.set(path, cb)
    }
    return cb
  }, [])

  // Scroll-spy: the active file is the last section whose top has scrolled to (or
  // above) the top of the viewport. rAF-throttled so it stays cheap while scrolling.
  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const container = scrollRef.current
      if (!container) return
      const top = container.getBoundingClientRect().top
      let current: string | null = null
      for (const f of files) {
        const el = sectionRefs.current.get(f.path)
        if (!el) continue
        if (el.getBoundingClientRect().top - top <= 60) current = f.path
        else break
      }
      if (current && current !== activePath) onSelectFile(current)
    })
  }, [files, activePath, onSelectFile])

  // Clicking a file in the list jumps the scroller to its section.
  const scrollToFile = useCallback(
    (path: string) => {
      const el = sectionRefs.current.get(path)
      const container = scrollRef.current
      if (el && container) {
        const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top
        container.scrollTo({ top: container.scrollTop + offset })
      }
      onSelectFile(path)
      if (!controls.docked) controls.toggleSheet("files")
    },
    [onSelectFile, controls.docked, controls.toggleSheet]
  )

  // Persisted, drag-resizable widths for the two side panels.
  const fileList = useResizableWidth({ storageKey: "sb.review.files", initial: 212, min: 160, max: 440 })
  const tray = useResizableWidth({ storageKey: "sb.review.tray.v2", initial: 300, min: 260, max: 480 })

  // Rails stop being columns whenever their persisted widths would leave an
  // unreadable diff. This must use actual pixels rather than the shared tier:
  // a split-screen pane can still classify as "wide" while two user-resized
  // rails consume most of it.
  //
  // Docked, they take a combined 420px minimum off the row before the diff gets
  // a single pixel — and `review-diff.tsx` then spends another 84px on fixed
  // line-number gutters. In a 500px pane that left roughly 70px of actual code,
  // which is not a narrower view of the diff so much as no view of it.
  const { width: paneWidth } = usePaneWidth()
  const availableDiffWidth = paneWidth - fileList.width - tray.width - 2
  const roomy = controls.docked
  // Undock as soon as the diff becomes unreadable, but require 40px of breathing
  // room before re-docking. Without this hysteresis, resizing the window around
  // the boundary can alternate layouts on every pixel.
  useEffect(() => {
    if (paneWidth === 0) return
    if (roomy && availableDiffWidth < MIN_READABLE_DIFF_WIDTH) controls.undock()
    if (!roomy && availableDiffWidth >= REDOCK_DIFF_WIDTH) controls.dock()
  }, [availableDiffWidth, controls.dock, controls.undock, paneWidth, roomy])
  const maxFileListWidth =
    paneWidth === 0
      ? 440
      : paneWidth - tray.width - MIN_READABLE_DIFF_WIDTH - 2
  const maxTrayWidth =
    paneWidth === 0
      ? 480
      : paneWidth - fileList.width - MIN_READABLE_DIFF_WIDTH - 2
  const compactActions = paneWidth > 0 && paneWidth < 720
  const sheetWidth = Math.min(300, Math.max(220, paneWidth > 0 ? paneWidth - 16 : 300))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header — source toggle (PR vs local) + the review's "finish" action. */}
      <div className="flex min-h-10 flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-[14px] py-1">
        <SegmentedControl
          value={source}
          onChange={onSetSource}
          items={[
            { value: "pr", label: "Pull Request", disabled: !prAvailable },
            { value: "local", label: "Uncommitted", disabled: !localAvailable }
          ]}
        />
        <div className="min-w-[8px] flex-1" />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={controls.focused}
          aria-label={controls.focused ? "Exit review focus" : "Focus diff"}
          title={controls.focused ? "Restore review panels" : "Show only the diff"}
          onClick={controls.toggleFocus}
          className={cn("min-h-10", compactActions && "size-10 p-0")}
        >
          {controls.focused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span className={cn(compactActions && "sr-only")}>
            {controls.focused ? "Exit focus" : "Focus"}
          </span>
        </Button>
        {!roomy && !controls.focused && (
          <>
            <button
              type="button"
              aria-label="Changed files"
              aria-pressed={controls.sheet === "files"}
              title="Changed files"
              onClick={() => controls.toggleSheet("files")}
              className={cn(
                "flex size-10 flex-none items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 ease-out hover:bg-hairline active:scale-[0.96]",
                controls.sheet === "files" ? "text-blue" : "text-dim hover:text-text-bright"
              )}
            >
              <PanelLeft size={15} />
            </button>
            <button
              type="button"
              aria-label="Review drafts"
              aria-pressed={controls.sheet === "tray"}
              title="Review drafts"
              onClick={() => controls.toggleSheet("tray")}
              className={cn(
                "flex size-10 flex-none items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 ease-out hover:bg-hairline active:scale-[0.96]",
                controls.sheet === "tray" ? "text-blue" : "text-dim hover:text-text-bright"
              )}
            >
              <PanelRight size={15} />
            </button>
          </>
        )}
        {!isLocal && (
          <Button
            size="sm"
            disabled={drafts.length === 0}
            onClick={() => onFinishReview("send_to_agent")}
          >
            Finish review
            <span className="rounded-sm bg-editor/25 px-1.5 py-px font-mono text-[10px]">
              {drafts.length}
            </span>
          </Button>
        )}
      </div>

      {!isLocal && !connected && (
        <div className="flex items-center gap-3 border-b border-hairline px-4 py-2.5">
          <Callout tone="blue" className="flex-1">
            {connectionMessage ?? "Connect GitHub to post this review."}
          </Callout>
          <Button variant="secondary" size="sm" onClick={onConnectGithub}>
            {connectionActionLabel}
          </Button>
        </div>
      )}

      {/* `relative` is what the two sheets anchor to when the pane is narrow —
          they float inside the body row rather than over the header, so the
          toggles that opened them stay visible and clickable. */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {/* File list — a resizable column when there's room, a left-hand sheet
            when there isn't. Same subtree either way: only its box changes. */}
        {!controls.focused && (
          <>
            <div
              data-testid="review-file-rail"
              style={{ width: roomy ? fileList.width : sheetWidth }}
              className={cn(
                "flex max-w-full flex-col border-r border-hairline bg-panel",
                roomy ? "flex-none" : "absolute inset-y-0 left-0 z-30 shadow-2xl",
                !roomy && controls.sheet !== "files" && "hidden"
              )}
            >
              <ReviewFileRail
                files={files}
                totalFiles={allFiles.length}
                activePath={activePath}
                feedback={feedback.byPath}
                feedbackAny={feedback.any}
                added={added}
                removed={removed}
                viewed={viewed}
                controls={controls}
                onSelectFile={scrollToFile}
                onToggleViewed={onToggleViewed}
              />
            </div>

            {roomy && (
              <ResizeHandle
                onResize={(dx) => fileList.adjust(dx, maxFileListWidth)}
                aria-label="Resize file list"
              />
            )}
          </>
        )}

        {/* Diff center — one continuous scroll through every changed file. Each
            file gets a sticky header; scrolling tracks the current file in the
            list, and clicking a file jumps here. */}
        <div
          data-testid="review-diff-center"
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor"
        >
          {/* Findings the reviewer didn't anchor to a file in this diff. Shown
              rather than dropped — an unanchored verdict still tells you
              something, and silently swallowing it is the worse failure. */}
          {general.length > 0 && (
            <div className="flex flex-col gap-2 border-b border-hairline bg-panel/40 p-4">
              <span className="text-[11px] font-semibold uppercase tracking-[0.4px] text-dim">
                Review · general
              </span>
              {general.map((finding) => (
                <ReviewFindingRow
                  key={finding.id}
                  finding={finding}
                  sent={sentFindingIds?.has(finding.id) ?? false}
                  canRoute={routeTargetSession !== null}
                  review={activeReview}
                  onSendToAgent={onSendFindingToAgent}
                />
              ))}
            </div>
          )}

          {files.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-[13px] text-dim">
              {/* The filter hiding everything is a different state from an empty
                  diff, and says so — otherwise a filtered view reads as "your
                  changes vanished". */}
              <span>{filtersActive ? "No files match these filters." : "No changes to review."}</span>
              {filtersActive && (
                <Button variant="secondary" size="sm" onClick={controls.clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            files.map((file) => (
              <div key={file.path} ref={setSectionRef(file.path)} className="flex flex-col">
                <ReviewFileSection
                  file={file}
                  diff={diffByPath.get(file.path) ?? ""}
                  estimatedHeight={heightByPath.get(file.path) ?? 0}
                  active={file.path === activePath}
                  connected={connected}
                  routeTargetSession={routeTargetSession}
                  local={isLocal}
                  compactActions={compactActions}
                  collapseViewed={controls.collapseViewed}
                  findings={byFile.get(file.path) ?? []}
                  review={activeReview}
                  sentFindingIds={sentFindingIds}
                  onAddDraft={onAddDraft}
                  onToggleViewed={onToggleViewed}
                  onRevertLines={onRevertLines}
                  onRevertFile={onRevertFile}
                  onDeslopFile={onDeslopFile}
                  onSendFindingToAgent={onSendFindingToAgent}
                />
              </div>
            ))
          )}
        </div>

        {!controls.focused && (
          <>
            {/* Review tray (resizable) — drag left edge; moving right shrinks it. */}
            {roomy && (
              <ResizeHandle
                onResize={(dx) => tray.adjust(-dx, maxTrayWidth)}
                aria-label="Resize review panel"
              />
            )}
            <div
              data-testid="review-tray"
              style={{ width: roomy ? tray.width : sheetWidth }}
              className={cn(
                "flex max-w-full border-l border-hairline",
                roomy ? "flex-none" : "absolute inset-y-0 right-0 z-30 shadow-2xl",
                !roomy && controls.sheet !== "tray" && "hidden"
              )}
            >
              <ReviewTray
                drafts={drafts}
                onRemoveDraft={onRemoveDraft}
                onFinishReview={onFinishReview}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
