import type {
  AdversarialReview,
  PrFileChange,
  PrReviewThread,
  ReviewFinding
} from "@jingler/core"
import { jinglerDark, toTokens } from "@jingler/themes"
import { Maximize2, Minimize2, PanelLeft, PanelRight } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { ResizeHandle, useResizableWidth } from "../components/resizable.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { PierreProvider } from "../diff/pierre-provider.js"
import type { JinglerLineSelection } from "../diff/pierre-selection.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { cn } from "../lib/cn.js"
import { feedbackCounts } from "../lib/review-feedback.js"
import {
  useOptionalThemeTokens,
  useThemeSyntax
} from "../theme-provider.js"
import { filterReviewFiles } from "./review-file-filter.js"
import { ReviewFileRail } from "./review-file-rail.js"
import { ReviewFindingRow, rankFindings } from "./review-findings.js"
import {
  createReviewCodeFiles,
  ReviewCodeView
} from "./review-code-view.js"
import { ReviewTray, type ReviewDraft } from "./review-tray.js"
import { useCodeReviewView } from "./use-code-review-view.js"

/** Which diff the Code Review is showing — the PR, or the worktree's own changes. */
export type ReviewSource = "pr" | "local"

const MIN_READABLE_DIFF_WIDTH = 560
const REDOCK_DIFF_WIDTH = 600
const FALLBACK_TOKENS = toTokens(jinglerDark)

export interface CodeReviewViewProps {
  files: readonly PrFileChange[]
  reviewThreads?: readonly PrReviewThread[]
  activePath: string | null
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
  onRevertLines?: (range: {
    path: string
    startLine: number
    endLine: number
  }) => void
  onRevertFile?: (path: string) => void
  review?: AdversarialReview | null
  onSendFindingToAgent?: (findingId: string) => void
  sentFindingIds?: ReadonlySet<string>
  onDeslopFile?: (path: string) => void
}

/**
 * The complete review workflow: one controlled Pierre CodeView, one stable
 * Pierre tree model, and Jingler-owned review actions/persistence around them.
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
  const theme = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  const [selectionState, setSelectionState] = useState<{
    readonly source: ReviewSource
    readonly selection: JinglerLineSelection | null
  }>({ source, selection: null })
  const selection =
    selectionState.source === source ? selectionState.selection : null
  const setSelection = useCallback(
    (next: JinglerLineSelection | null) => {
      setSelectionState({ source, selection: next })
    },
    [source]
  )
  const [scrollRequest, setScrollRequest] = useState<{
    readonly path: string
    readonly revision: number
    readonly behavior: "instant" | "smooth"
  } | null>(null)
  const scrollRevision = useRef(0)

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

  // XState owns every filter; this single derived array drives both tree and
  // CodeView, so navigation can never expose code the file tree says is hidden.
  const files = useMemo(
    () =>
      filterReviewFiles(allFiles, {
        query: controls.query,
        kind: controls.kind,
        feedbackPaths: controls.feedbackOnly
          ? new Set(feedback.byPath.keys())
          : undefined
      }),
    [allFiles, controls.feedbackOnly, controls.kind, controls.query, feedback]
  )
  const filtersActive =
    controls.query.trim().length > 0 ||
    controls.kind !== "all" ||
    controls.feedbackOnly

  useEffect(() => {
    if (files.length === 0) return
    if (activePath !== null && files.some((file) => file.path === activePath)) return
    onSelectFile(files[0]!.path)
  }, [activePath, files, onSelectFile])

  useEffect(() => {
    if (selection === null) return
    if (!files.some((file) => file.path === selection.path)) setSelection(null)
  }, [files, selection, setSelection])

  useEffect(() => {
    if (controls.feedbackOnly && !feedback.any) controls.clearFeedback()
  }, [controls.clearFeedback, controls.feedbackOnly, feedback.any])

  const entries = useMemo(
    () => createReviewCodeFiles(files, fileDiffs),
    [fileDiffs, files]
  )
  const statusByPath = useMemo(
    () => new Map(entries.map((entry) => [entry.file.path, entry.status])),
    [entries]
  )

  const { byFile, general } = useMemo(() => {
    const ranked = rankFindings(activeReview?.findings ?? [])
    const paths = new Set(allFiles.map((file) => file.path))
    const byFile = new Map<string, ReviewFinding[]>()
    const general: ReviewFinding[] = []
    for (const finding of ranked) {
      if (finding.path !== null && paths.has(finding.path)) {
        byFile.set(finding.path, [...(byFile.get(finding.path) ?? []), finding])
      } else {
        general.push(finding)
      }
    }
    return { byFile, general }
  }, [activeReview, allFiles])

  const added = files.reduce((sum, file) => sum + file.additions, 0)
  const removed = files.reduce((sum, file) => sum + file.deletions, 0)
  const viewed = files.filter((file) => file.viewed).length

  const scrollToFile = useCallback(
    (path: string) => {
      scrollRevision.current += 1
      setScrollRequest({
        path,
        revision: scrollRevision.current,
        behavior: "smooth"
      })
      onSelectFile(path)
      if (!controls.docked) controls.closeSheet()
    },
    [controls.closeSheet, controls.docked, onSelectFile]
  )

  const handleActivePathChange = useCallback(
    (path: string) => {
      if (path !== activePath) onSelectFile(path)
    },
    [activePath, onSelectFile]
  )

  const fileList = useResizableWidth({
    storageKey: "sb.review.files",
    initial: 212,
    min: 160,
    max: 440
  })
  const tray = useResizableWidth({
    storageKey: "sb.review.tray.v2",
    initial: 300,
    min: 260,
    max: 480
  })
  const { width: paneWidth } = usePaneWidth()
  const availableDiffWidth = paneWidth - fileList.width - tray.width - 2
  const roomy = controls.docked
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
  const sheetWidth = Math.min(
    300,
    Math.max(220, paneWidth > 0 ? paneWidth - 16 : 300)
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                controls.sheet === "files"
                  ? "text-blue"
                  : "text-dim hover:text-text-bright"
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
                controls.sheet === "tray"
                  ? "text-blue"
                  : "text-dim hover:text-text-bright"
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

      <PierreProvider
        theme={theme}
        tokens={tokens ?? FALLBACK_TOKENS}
        workers
      >
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {!controls.focused && (
            <>
              <div
                data-testid="review-file-rail"
                style={{ width: roomy ? fileList.width : sheetWidth }}
                className={cn(
                  "flex max-w-full flex-col border-r border-hairline bg-panel",
                  roomy
                    ? "flex-none"
                    : "absolute inset-y-0 left-0 z-30 shadow-2xl",
                  !roomy && controls.sheet !== "files" && "hidden"
                )}
              >
                <ReviewFileRail
                  files={files}
                  totalFiles={allFiles.length}
                  activePath={activePath}
                  feedback={feedback.byPath}
                  feedbackAny={feedback.any}
                  statusByPath={statusByPath}
                  added={added}
                  removed={removed}
                  viewed={viewed}
                  controls={controls}
                  onSelectFile={scrollToFile}
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

          <div
            data-testid="review-diff-center"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-editor"
          >
            {general.length > 0 && (
              <div className="flex flex-none flex-col gap-2 border-b border-hairline bg-panel/40 p-4">
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
                <span>
                  {filtersActive
                    ? "No files match these filters."
                    : "No changes to review."}
                </span>
                {filtersActive && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={controls.clearFilters}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <ReviewCodeView
                entries={entries}
                selection={selection}
                scrollRequest={scrollRequest}
                drafts={drafts}
                reviewThreads={reviewThreads}
                findingsByPath={byFile}
                review={activeReview}
                sentFindingIds={sentFindingIds}
                connected={connected}
                routeTargetSession={routeTargetSession}
                local={isLocal}
                compactActions={compactActions}
                collapseViewed={controls.collapseViewed}
                onSelectionChange={setSelection}
                onActivePathChange={handleActivePathChange}
                onAddDraft={onAddDraft}
                onRemoveDraft={onRemoveDraft}
                onToggleViewed={onToggleViewed}
                onRevertLines={onRevertLines}
                onRevertFile={onRevertFile}
                onDeslopFile={onDeslopFile}
                onSendFindingToAgent={onSendFindingToAgent}
              />
            )}
          </div>

          {!controls.focused && (
            <>
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
                  roomy
                    ? "flex-none"
                    : "absolute inset-y-0 right-0 z-30 shadow-2xl",
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
      </PierreProvider>
    </div>
  )
}
