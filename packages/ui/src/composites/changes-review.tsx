/**
 * Changes review, split across the surfaces it now lives in.
 *
 * There used to be one Changes view: file rail, stacked diff and review tray in
 * a single pane. Those are three different jobs, and the repository Explorer
 * already owned the first one. So the Explorer filters itself down to changed
 * files (`ChangedFilesExplorer`), a file opens into the Files view as a review
 * diff (`ReviewFileDiff`), and the tray (`ReviewSidebar`) only exists once the
 * operator has collected something to send.
 */
import type {
  AdversarialReview,
  PrFileChange,
  PrReviewThread,
  ReviewFinding
} from "@jingler/core"
import { jinglerDark, toTokens } from "@jingler/themes"
import { Maximize2, Minimize2 } from "lucide-react"
import { useCallback, useMemo, useState, type ReactNode } from "react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { PierreProvider, type PierreCodeViewProps } from "../diff/pierre-provider.js"
import type { JinglerLineSelection } from "../diff/pierre-selection.js"
import { cn } from "../lib/cn.js"
import { feedbackCounts } from "../lib/review-feedback.js"
import { useOptionalThemeTokens, useThemeSyntax } from "../theme-provider.js"
import { filterReviewFiles } from "./review-file-filter.js"
import { ReviewFileRail } from "./review-file-rail.js"
import { ReviewFindingRow, rankFindings } from "./review-findings.js"
import { createReviewCodeFiles, ReviewCodeView } from "./review-code-view.js"
import { ReviewTray, type ReviewDraft } from "./review-tray.js"
import { useCodeReviewView } from "./use-code-review-view.js"

/** Which diff a review shows — the PR, or the worktree's uncommitted changes. */
export type ReviewSource = "pr" | "local"

/** What the Explorer lists: the whole repository, or one diff source's changes. */
export type ExplorerFilter = "all" | ReviewSource

/** A changed file listed with counts whose patch was too large to transport. */
export interface ReviewOmittedFile {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly reason: "lines" | "bytes"
}

export interface ReviewDraftInput {
  readonly path: string
  readonly line: number
  readonly endLine: number | null
  readonly body: string
  readonly routeToAgent: boolean
}

const FALLBACK_TOKENS = toTokens(jinglerDark)
const OMITTED_PREVIEW = 5
const count = new Intl.NumberFormat("en-US")

function ReviewPierre({ children }: { readonly children: ReactNode }) {
  const theme = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  return (
    <PierreProvider theme={theme} tokens={tokens ?? FALLBACK_TOKENS} workers>
      {children}
    </PierreProvider>
  )
}

export function OmittedFilesNotice({
  files,
  diffLineLimit
}: {
  readonly files: readonly ReviewOmittedFile[]
  readonly diffLineLimit: number
}) {
  if (files.length === 0) return null
  return (
    <div
      data-testid="review-omitted-files"
      className="flex-none border-b border-hairline bg-panel/40 p-3"
    >
      <Callout tone="yellow">
        {files.length === 1
          ? "One file is too large to show inline"
          : `${count.format(files.length)} files are too large to show inline`}
        {diffLineLimit > 0
          ? ` (over ${count.format(diffLineLimit)} changed lines or the size cap). `
          : ". "}
        {files
          .slice(0, OMITTED_PREVIEW)
          .map(
            (file) =>
              `${file.path} (+${count.format(file.added)} −${count.format(file.removed)})`
          )
          .join(", ")}
        {files.length > OMITTED_PREVIEW
          ? ` and ${count.format(files.length - OMITTED_PREVIEW)} more.`
          : "."}
      </Callout>
    </div>
  )
}

export interface ExplorerPanelProps {
  readonly branch: string
  readonly worktreePath?: string
  /** The filter to SHOW — the effective source, when a PR falls back to local. */
  readonly filter: ExplorerFilter
  readonly onFilterChange: (filter: ExplorerFilter) => void
  readonly localAvailable: boolean
  readonly prAvailable: boolean
  /** The repository tree, or `ChangedFilesExplorer` when filtered. */
  readonly children: ReactNode
}

/**
 * The sidebar Explorer: the worktree it shows, and a filter between the whole
 * repository and one diff source's changed files. The Changes rail button sets
 * the filter; picking "All files" returns to the plain tree.
 */
export function ExplorerPanel({
  branch,
  worktreePath,
  filter,
  onFilterChange,
  localAvailable,
  prAvailable,
  children
}: ExplorerPanelProps) {
  return (
    <section aria-label="Worktree explorer" className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-hairline px-3 py-2">
        <div className="truncate font-mono text-[10.5px] text-text">{branch}</div>
        {worktreePath ? (
          <div className="truncate text-[10px] text-dim" title={worktreePath}>
            {worktreePath}
          </div>
        ) : null}
        <div className="mt-2">
          <SegmentedControl<ExplorerFilter>
            value={filter}
            onChange={onFilterChange}
            className="w-full"
            items={[
              { value: "all", label: "All files" },
              { value: "local", label: "Uncommitted", disabled: !localAvailable },
              { value: "pr", label: "Pull request", disabled: !prAvailable }
            ]}
          />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  )
}

export interface ChangedFilesExplorerProps {
  readonly files: readonly PrFileChange[]
  readonly fileDiffs: readonly { readonly path: string; readonly diff: string }[]
  readonly omittedFiles?: readonly ReviewOmittedFile[]
  readonly diffLineLimit?: number
  readonly drafts: readonly ReviewDraft[]
  readonly reviewThreads?: readonly PrReviewThread[]
  /** The adversarial review's findings count as feedback on their files. */
  readonly review?: AdversarialReview | null
  readonly activePath: string | null
  readonly onSelectFile: (path: string) => void
}

/**
 * The Explorer, filtered to one diff source's changed files: search, kind and
 * feedback filters, per-file status and counts, and viewed progress.
 */
export function ChangedFilesExplorer({
  files: allFiles,
  fileDiffs,
  omittedFiles = [],
  diffLineLimit = 0,
  drafts,
  reviewThreads = [],
  review = null,
  activePath,
  onSelectFile
}: ChangedFilesExplorerProps) {
  const controls = useCodeReviewView()
  const feedback = useMemo(
    () =>
      feedbackCounts({
        files: allFiles,
        findings: review?.findings ?? [],
        drafts,
        threads: reviewThreads
      }),
    [allFiles, review, drafts, reviewThreads]
  )
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
  const statusByPath = useMemo(
    () =>
      new Map(
        createReviewCodeFiles(files, fileDiffs).map((entry) => [entry.file.path, entry.status])
      ),
    [fileDiffs, files]
  )
  const added = files.reduce((sum, file) => sum + file.additions, 0)
  const removed = files.reduce((sum, file) => sum + file.deletions, 0)
  const viewed = files.filter((file) => file.viewed).length

  return (
    <ReviewPierre>
      <div data-testid="changed-files-explorer" className="flex h-full min-h-0 flex-col">
        <OmittedFilesNotice files={omittedFiles} diffLineLimit={diffLineLimit} />
        {allFiles.length === 0 ? (
          <div className="p-4 text-[12px] text-dim">No changes to review.</div>
        ) : (
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
            onSelectFile={onSelectFile}
          />
        )}
      </div>
    </ReviewPierre>
  )
}

export interface ReviewFileDiffProps {
  readonly file: PrFileChange
  /** This file's unified diff. */
  readonly diff: string
  readonly source: ReviewSource
  readonly drafts: readonly ReviewDraft[]
  readonly reviewThreads?: readonly PrReviewThread[]
  readonly review?: AdversarialReview | null
  readonly sentFindingIds?: ReadonlySet<string>
  readonly connected: boolean
  readonly routeTargetSession: string | null
  readonly focused: boolean
  readonly onToggleFocus: () => void
  readonly onAddDraft: (draft: ReviewDraftInput) => void
  /** "Send to agent" in the comment box: hand one comment to the agent now. */
  readonly onSendComment?: (comment: ReviewDraftInput) => void
  readonly onRemoveDraft: (id: string) => void
  readonly onToggleViewed: (path: string, viewed: boolean) => void
  readonly onRevertLines?: (range: { path: string; startLine: number; endLine: number }) => void
  readonly onRevertFile?: (path: string) => void
  readonly onDeslopFile?: (path: string) => void
  readonly onSendFindingToAgent?: (findingId: string) => void
  readonly onTokenEnter?: PierreCodeViewProps["onTokenEnter"]
  readonly onTokenLeave?: PierreCodeViewProps["onTokenLeave"]
  /** Rendered at the start of the header, e.g. the Files view's mode toggle. */
  readonly toolbar?: ReactNode
}

/**
 * One changed file's review diff: inline drafts, PR threads, anchored findings,
 * viewed toggle, reverts and deslop — everything the stacked Changes view did,
 * scoped to the file the Explorer opened.
 */
export function ReviewFileDiff({
  file,
  diff,
  source,
  drafts,
  reviewThreads = [],
  review = null,
  sentFindingIds,
  connected,
  routeTargetSession,
  focused,
  onToggleFocus,
  onAddDraft,
  onSendComment,
  onRemoveDraft,
  onToggleViewed,
  onRevertLines,
  onRevertFile,
  onDeslopFile,
  onSendFindingToAgent,
  onTokenEnter,
  onTokenLeave,
  toolbar
}: ReviewFileDiffProps) {
  const [selection, setSelection] = useState<JinglerLineSelection | null>(null)
  const local = source === "local"
  // Findings exist for the PR; on the uncommitted diff their lines don't match.
  const activeReview = local ? null : review
  const entries = useMemo(
    () => createReviewCodeFiles([file], [{ path: file.path, diff }]),
    [diff, file]
  )
  const findingsByPath = useMemo(() => {
    const findings: ReviewFinding[] = rankFindings(activeReview?.findings ?? [])
      .filter((finding) => finding.path === file.path)
    return new Map([[file.path, findings]])
  }, [activeReview, file.path])
  const fileDrafts = useMemo(
    () => drafts.filter((draft) => draft.path === file.path),
    [drafts, file.path]
  )
  const fileThreads = useMemo(
    () => (local ? [] : reviewThreads.filter((thread) => thread.path === file.path)),
    [file.path, local, reviewThreads]
  )
  const ignoreActivePath = useCallback(() => {}, [])

  return (
    <div data-testid="review-file-diff" className="flex h-full min-h-0 flex-col bg-editor">
      <div className="flex h-8 flex-none items-center gap-2 border-b border-hairline bg-panel px-2">
        {toolbar}
        <span className="rounded bg-sunken px-1.5 py-px text-[10px] font-medium text-dim">
          {local ? "Uncommitted" : "Pull request"}
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={focused}
          aria-label={focused ? "Exit review focus" : "Focus diff"}
          title={focused ? "Restore the review panels" : "Show only the diff"}
          onClick={onToggleFocus}
          className="h-6 gap-1 px-1.5 text-[11px]"
        >
          {focused ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          {focused ? "Exit focus" : "Focus"}
        </Button>
      </div>
      <ReviewPierre>
        <ReviewCodeView
          entries={entries}
          selection={selection}
          scrollRequest={undefined}
          drafts={fileDrafts}
          reviewThreads={fileThreads}
          findingsByPath={findingsByPath}
          review={activeReview}
          sentFindingIds={sentFindingIds}
          connected={connected}
          routeTargetSession={routeTargetSession}
          local={local}
          compactActions={false}
          collapseViewed={false}
          onSelectionChange={setSelection}
          onActivePathChange={ignoreActivePath}
          onAddDraft={onAddDraft}
          onSendComment={onSendComment}
          onRemoveDraft={onRemoveDraft}
          onToggleViewed={onToggleViewed}
          onRevertLines={local ? onRevertLines : undefined}
          onRevertFile={local ? onRevertFile : undefined}
          onDeslopFile={onDeslopFile}
          onSendFindingToAgent={onSendFindingToAgent}
          onTokenEnter={onTokenEnter}
          onTokenLeave={onTokenLeave}
        />
      </ReviewPierre>
    </div>
  )
}

export interface ReviewSidebarProps {
  readonly drafts: readonly ReviewDraft[]
  readonly source: ReviewSource
  readonly connected: boolean
  readonly connectionMessage?: string
  readonly connectionActionLabel?: string
  readonly review?: AdversarialReview | null
  readonly sentFindingIds?: ReadonlySet<string>
  readonly routeTargetSession: string | null
  /** Paths that are part of this review; findings elsewhere are "general". */
  readonly paths: ReadonlySet<string>
  readonly onConnectGithub?: () => void
  readonly onRemoveDraft: (id: string) => void
  readonly onFinishReview: (mode: "comment_only" | "send_to_agent") => void
  readonly onSendFindingToAgent?: (findingId: string) => void
}

/**
 * The review tray, beside the session's panes. It exists only while there is
 * something to act on — collected drafts, or PR findings no file owns — so an
 * idle session never pays its width.
 */
export function ReviewSidebar({
  drafts,
  source,
  connected,
  connectionMessage,
  connectionActionLabel = "Connect GitHub",
  review = null,
  sentFindingIds,
  routeTargetSession,
  paths,
  onConnectGithub,
  onRemoveDraft,
  onFinishReview,
  onSendFindingToAgent
}: ReviewSidebarProps) {
  const activeReview = source === "pr" ? review : null
  const general = useMemo(
    () =>
      rankFindings(activeReview?.findings ?? []).filter(
        (finding) => finding.path === null || !paths.has(finding.path)
      ),
    [activeReview, paths]
  )
  if (drafts.length === 0 && general.length === 0) return null
  return (
    <aside
      data-testid="review-tray"
      aria-label="Review"
      className="flex w-[300px] min-w-0 flex-none flex-col border-l border-hairline bg-panel"
    >
      {source === "pr" && !connected && drafts.length > 0 ? (
        <div className="flex flex-none items-center gap-2 border-b border-hairline p-2">
          <Callout tone="blue" className="flex-1 text-[11.5px]">
            {connectionMessage ?? "Connect GitHub to post this review."}
          </Callout>
          {onConnectGithub ? (
            <Button variant="secondary" size="sm" onClick={onConnectGithub}>
              {connectionActionLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {general.length > 0 ? (
        <div className="flex max-h-[40%] flex-none flex-col gap-2 overflow-y-auto border-b border-hairline p-3">
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
      ) : null}
      <div className={cn("flex min-h-0 flex-1", drafts.length === 0 && "hidden")}>
        <ReviewTray
          drafts={drafts}
          onRemoveDraft={onRemoveDraft}
          onFinishReview={onFinishReview}
        />
      </div>
    </aside>
  )
}
