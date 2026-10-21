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
import { useCallback, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react"
import { Button } from "../components/button.js"
import { Badge } from "../components/badge.js"
import { Callout } from "../components/callout.js"
import { DiffStat } from "../components/diff-stat.js"
import { EmptyState, InlineError, ListSkeleton } from "../components/feedback.js"
import { FilterChips } from "../components/filter-chips.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { PierreProvider, type PierreCodeViewProps } from "../diff/pierre-provider.js"
import type { JinglerLineSelection } from "../diff/pierre-selection.js"
import { cn } from "../lib/cn.js"
import { feedbackCounts } from "../lib/review-feedback.js"
import { useOptionalThemeTokens, useThemeSyntax } from "../theme-provider.js"
import { AgentFileRows } from "./agent-file-rows.js"
import { AgentScopeFilter } from "./agent-scope-filter.js"
import { filterReviewFiles } from "./review-file-filter.js"
import {
  CHANGES_SCOPE_ALL,
  mergeAgentTrees,
  sumAgentRows,
  type AgentTreeChanges
} from "./review-agent-scope.js"
import { ReviewFileRail } from "./review-file-rail.js"
import { FindingsList, rankFindings } from "./review-findings.js"
import { createReviewCodeFiles, ReviewCodeView } from "./review-code-view.js"
import { narrowToTurn, type ReviewTurn } from "./review-turns.js"
import { ReviewTray, type ReviewDraft } from "./review-tray.js"
import { TurnFilter } from "./turn-filter.js"
import { PrFilter, type PrFilterLayer } from "./pr-filter.js"
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
      <Callout tone="blue">
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
  readonly localCount?: number
  readonly prCount?: number
  readonly prNumber?: number
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
  localCount,
  prCount,
  prNumber,
  children
}: ExplorerPanelProps) {
  const options = [
    { value: "all" as const, label: "All" },
    ...(localAvailable ? [{ value: "local" as const, label: "Changed", count: localCount }] : []),
    ...(prAvailable ? [{ value: "pr" as const, label: prNumber ? `PR #${prNumber}` : "PR", count: prCount }] : [])
  ]

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
          <FilterChips
            options={options}
            value={filter}
            onChange={onFilterChange}
            ariaLabel="Explorer filter"
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
  /**
   * Per-checkout changed files (main + each subagent worktree with its own
   * files). Fewer than two trees renders exactly the single-tree list below;
   * two or more switches to the agent scope filter and per-agent rows.
   */
  readonly agentTrees?: readonly AgentTreeChanges[]
  /** Agent scope (CHANGES_SCOPE_ALL, CHANGES_SCOPE_MAIN or a subagent id); local state when omitted. */
  readonly agentScope?: string
  readonly onAgentScopeChange?: (scope: string) => void
  readonly omittedFiles?: readonly ReviewOmittedFile[]
  readonly diffLineLimit?: number
  readonly drafts: readonly ReviewDraft[]
  readonly reviewThreads?: readonly PrReviewThread[]
  /** The adversarial review's findings count as feedback on their files. */
  readonly review?: AdversarialReview | null
  readonly activePath: string | null
  readonly onSelectFile: (path: string) => void
  /** Right-click → "Discard file changes" on a row; omit when nothing local can be discarded. */
  readonly onDiscardFile?: (path: string) => void
  /** Agent turns that changed files; the filter shows when there are any. */
  readonly turns?: readonly ReviewTurn[]
  readonly turnId?: string | null
  readonly onTurnChange?: (turnId: string | null) => void
  /** Stack layers the PR filter can select between; the filter shows with two or more. */
  readonly prLayers?: readonly PrFilterLayer[]
  readonly prNumber?: number | null
  readonly onPrNumberChange?: (number: number) => void
  /** The change list is still loading: show placeholder rows at real height. */
  readonly loading?: boolean
  /** The change list failed to load; `onRetry` adds the Retry button. */
  readonly error?: string | null
  readonly onRetry?: () => void
}

/**
 * The Explorer, filtered to one diff source's changed files: search, kind and
 * feedback filters, per-file status and counts, and viewed progress.
 */
/** The turn filter strip; renders nothing without turns or a change handler. */
function TurnFilterBar({
  turns,
  value,
  onChange
}: {
  readonly turns: ComponentProps<typeof TurnFilter>["turns"]
  readonly value: string | null
  readonly onChange: ((id: string | null) => void) | undefined
}) {
  if (turns.length === 0 || !onChange) return null
  return (
    <div className="flex-none border-b border-hairline p-2">
      <TurnFilter turns={turns} value={value} onChange={onChange} />
    </div>
  )
}

/** The PR-layer filter strip; renders nothing without two or more stack layers. */
function PrFilterBar({
  layers,
  value,
  onChange
}: {
  readonly layers: readonly PrFilterLayer[]
  readonly value: number | null
  readonly onChange: ((number: number) => void) | undefined
}) {
  if (layers.length < 2 || !onChange || value === null) return null
  return (
    <div className="flex-none border-b border-hairline p-2">
      <PrFilter layers={layers} value={value} onChange={onChange} />
    </div>
  )
}

/** The changed-files list once two or more agent trees exist: scope filter plus per-agent rows. */
function AgentScopedFileList({
  trees,
  scope,
  onScopeChange,
  activePath,
  onSelectFile
}: {
  readonly trees: readonly AgentTreeChanges[]
  readonly scope: string
  readonly onScopeChange: (scope: string) => void
  readonly activePath: string | null
  readonly onSelectFile: (path: string) => void
}) {
  const rows = useMemo(() => mergeAgentTrees(trees, scope), [trees, scope])
  const totals = useMemo(() => sumAgentRows(rows), [rows])
  const activeKey = rows.find((row) => row.file.path === activePath)?.key ?? null
  return (
    <>
      <div className="flex h-[42px] flex-none items-center gap-2 border-b border-hairline px-[14px]">
        <span className="flex-1 text-[12px] font-semibold text-text-bright">Changed files</span>
        <DiffStat added={totals.added} removed={totals.removed} className="text-[10.5px]" />
      </div>
      <div className="flex-none border-b border-hairline p-2">
        <AgentScopeFilter trees={trees} value={scope} onChange={onScopeChange} />
      </div>
      <AgentFileRows rows={rows} activeKey={activeKey} onSelectRow={(row) => onSelectFile(row.file.path)} />
    </>
  )
}

/** The empty state for a zero-file layer: a PR-stack-specific message once there's a layer to blame. */
function ChangedFilesEmptyState({ hasPrLayers }: { readonly hasPrLayers: boolean }) {
  return hasPrLayers ? (
    <EmptyState title="No commits in this layer" description="Pick another PR layer to see its changes." />
  ) : (
    <EmptyState title="No changes yet" description="Files the agent edits show up here." />
  )
}

/** The computed file list, feedback counts and derived stats `ChangedFilesExplorer` renders. */
function useChangedFilesView(
  sourceFiles: readonly PrFileChange[],
  sourceDiffs: readonly { readonly path: string; readonly diff: string }[],
  turn: ReviewTurn | null,
  drafts: readonly ReviewDraft[],
  reviewThreads: readonly PrReviewThread[],
  review: AdversarialReview | null,
  controls: ReturnType<typeof useCodeReviewView>
) {
  const allFiles = useMemo(() => narrowToTurn(sourceFiles, turn), [sourceFiles, turn])
  const fileDiffs = useMemo(() => narrowToTurn(sourceDiffs, turn), [sourceDiffs, turn])
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
          : undefined,
        hideViewed: controls.hideViewed
      }),
    [allFiles, controls.feedbackOnly, controls.hideViewed, controls.kind, controls.query, feedback]
  )
  // "With feedback" with nothing left to show would strand an empty list.
  const { feedbackOnly, clearFeedback } = controls
  useEffect(() => {
    if (feedbackOnly && !feedback.any) clearFeedback()
  }, [clearFeedback, feedback.any, feedbackOnly])
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
  return { allFiles, fileDiffs, feedback, files, statusByPath, added, removed, viewed }
}

/** The loaded-and-non-empty body: file list, turn/PR filter bars, no-match banner. */
function ChangedFilesBody({
  omittedFiles,
  diffLineLimit,
  turns,
  turnId,
  onTurnChange,
  prLayers,
  prNumber,
  onPrNumberChange,
  multiAgent,
  agentTrees,
  agentScope,
  onAgentScopeChange,
  activePath,
  onSelectFile,
  onDiscardFile,
  view,
  controls
}: {
  readonly omittedFiles: readonly ReviewOmittedFile[]
  readonly diffLineLimit: number
  readonly turns: readonly ReviewTurn[]
  readonly turnId: string | null
  readonly onTurnChange: ((id: string | null) => void) | undefined
  readonly prLayers: readonly PrFilterLayer[]
  readonly prNumber: number | null
  readonly onPrNumberChange: ((number: number) => void) | undefined
  readonly multiAgent: boolean
  readonly agentTrees: readonly AgentTreeChanges[]
  readonly agentScope: string
  readonly onAgentScopeChange: (scope: string) => void
  readonly activePath: string | null
  readonly onSelectFile: (path: string) => void
  readonly onDiscardFile: ((path: string) => void) | undefined
  readonly view: ReturnType<typeof useChangedFilesView>
  readonly controls: ReturnType<typeof useCodeReviewView>
}) {
  const { allFiles, fileDiffs: _fileDiffs, feedback, files, statusByPath, added, removed, viewed } = view
  return (
    <ReviewPierre>
      <div data-testid="changed-files-explorer" className="flex h-full min-h-0 flex-col">
        <OmittedFilesNotice files={omittedFiles} diffLineLimit={diffLineLimit} />
        <TurnFilterBar turns={turns} value={turnId} onChange={onTurnChange} />
        <PrFilterBar layers={prLayers} value={prNumber} onChange={onPrNumberChange} />
        {allFiles.length === 0 ? (
          <ChangedFilesEmptyState hasPrLayers={prLayers.length >= 2} />
        ) : multiAgent ? (
          <AgentScopedFileList trees={agentTrees} scope={agentScope} onScopeChange={onAgentScopeChange} activePath={activePath} onSelectFile={onSelectFile} />
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
            onDiscardFile={onDiscardFile}
          />
        )}
        {allFiles.length > 0 && files.length === 0 ? (
          <div className="flex flex-col items-start gap-2 p-4 text-[12px] text-dim">
            No files match these filters.
            <Button variant="secondary" size="sm" onClick={controls.clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : null}
      </div>
    </ReviewPierre>
  )
}

export function ChangedFilesExplorer({
  files: sourceFiles,
  fileDiffs: sourceDiffs,
  omittedFiles = [],
  diffLineLimit = 0,
  drafts,
  reviewThreads = [],
  review = null,
  activePath,
  onSelectFile,
  onDiscardFile,
  turns = [],
  turnId = null,
  onTurnChange,
  prLayers = [],
  prNumber = null,
  onPrNumberChange,
  loading = false,
  error = null,
  onRetry,
  agentTrees = [],
  agentScope,
  onAgentScopeChange
}: ChangedFilesExplorerProps) {
  const [localScope, setLocalScope] = useState(CHANGES_SCOPE_ALL)
  const controls = useCodeReviewView()
  // More than one tree (main + at least one subagent worktree) switches the
  // list to the agent-scoped rows; a single tree renders exactly as before.
  const multiAgent = agentTrees.length > 1
  const turn = turns.find((candidate) => candidate.id === turnId) ?? null
  const view = useChangedFilesView(sourceFiles, sourceDiffs, turn, drafts, reviewThreads, review, controls)

  if (error !== null) {
    return (
      <div data-testid="changed-files-explorer" className="p-3">
        <InlineError message={error} onRetry={onRetry} />
      </div>
    )
  }
  if (loading) {
    return (
      <div data-testid="changed-files-explorer" className="p-3">
        <ListSkeleton rows={6} rowHeight={24} gap={6} />
      </div>
    )
  }

  return (
    <ChangedFilesBody
      omittedFiles={omittedFiles}
      diffLineLimit={diffLineLimit}
      turns={turns}
      turnId={turn?.id ?? null}
      onTurnChange={onTurnChange}
      prLayers={prLayers}
      prNumber={prNumber}
      onPrNumberChange={onPrNumberChange}
      multiAgent={multiAgent}
      agentTrees={agentTrees}
      agentScope={agentScope ?? localScope}
      onAgentScopeChange={onAgentScopeChange ?? setLocalScope}
      activePath={activePath}
      onSelectFile={onSelectFile}
      onDiscardFile={onDiscardFile}
      view={view}
      controls={controls}
    />
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
  readonly dismissedFindingIds?: ReadonlySet<string>
  readonly onDismissFinding?: (findingId: string, dismissed?: boolean) => void
  readonly connected: boolean
  readonly routeTargetSession: string | null
  readonly focused: boolean
  readonly onToggleFocus: () => void
  readonly onAddDraft: (draft: ReviewDraftInput) => void
  /** "Send to agent" in the comment box: hand one comment to the agent now. */
  readonly onSendComment?: (comment: ReviewDraftInput) => void
  readonly onRemoveDraft: (id: string) => void
  readonly onToggleViewed: (path: string, viewed: boolean) => void
  readonly onDeslopFile?: (path: string) => void
  readonly onSendFindingToAgent?: (findingId: string) => void
  readonly onTokenEnter?: PierreCodeViewProps["onTokenEnter"]
  readonly onTokenLeave?: PierreCodeViewProps["onTokenLeave"]
  /** Rendered at the start of the header, e.g. the Files view's mode toggle. */
  readonly toolbar?: ReactNode
}

/**
 * One changed file's review diff: inline drafts, PR threads, anchored findings,
 * viewed toggle and deslop — everything the stacked Changes view did,
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
  dismissedFindingIds,
  onDismissFinding,
  connected,
  routeTargetSession,
  focused,
  onToggleFocus,
  onAddDraft,
  onSendComment,
  onRemoveDraft,
  onToggleViewed,
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
        <Badge size="xs">{local ? "Uncommitted" : "Pull request"}</Badge>
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
          dismissedFindingIds={dismissedFindingIds}
          onDismissFinding={onDismissFinding}
          connected={connected}
          routeTargetSession={routeTargetSession}
          compactActions={false}
          collapseViewed={false}
          onSelectionChange={setSelection}
          onActivePathChange={ignoreActivePath}
          onAddDraft={onAddDraft}
          onSendComment={onSendComment}
          onRemoveDraft={onRemoveDraft}
          onToggleViewed={onToggleViewed}
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
  readonly dismissedFindingIds?: ReadonlySet<string>
  readonly onDismissFinding?: (findingId: string, dismissed?: boolean) => void
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
  dismissedFindingIds,
  onDismissFinding,
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
          <FindingsList
            findings={general}
            review={activeReview}
            sentFindingIds={sentFindingIds}
            canRoute={routeTargetSession !== null}
            onSendFindingToAgent={onSendFindingToAgent}
            dismissedFindingIds={dismissedFindingIds}
            onDismissFinding={onDismissFinding}
          />
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
