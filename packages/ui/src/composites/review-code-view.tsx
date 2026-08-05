import type {
  AdversarialReview,
  PrFileChange,
  PrReviewThread,
  ReviewFinding
} from "@jingler/core"
import type { CodeViewItem, FileDiffMetadata } from "@pierre/diffs"
import { BrushCleaning, EyeOff, Trash2, Undo2 } from "lucide-react"
import { useCallback, useMemo, type ReactNode } from "react"
import { Button } from "../components/button.js"
import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"
import {
  createPierreDiffAnnotation,
  PierreAnnotationRegion,
  type PierreAnnotationMetadata,
  type PierreAnnotationPayload
} from "../diff/pierre-annotations.js"
import {
  canonicalPierrePath,
  createPierreCodeViewItem,
  createPierreFileDiff,
  jinglerStatusFromPierreDiff,
  pierreCacheKey,
  pierreItemVersion,
  type JinglerFileStatus
} from "../diff/pierre-model.js"
import {
  PierreCodeView,
  type PierreCodeViewProps
} from "../diff/pierre-provider.js"
import type { JinglerLineSelection } from "../diff/pierre-selection.js"
import { parsePierreFileDiffs } from "../diff/parse.js"
import { cn } from "../lib/cn.js"
import { InlineCommentComposer } from "./inline-comment-composer.js"
import { PrReviewThreadView } from "./pr-review-thread.js"
import { ReviewFindingRow } from "./review-findings.js"
import type { ReviewDraft } from "./review-tray.js"

export interface ReviewCodeFile {
  readonly file: PrFileChange
  readonly fileDiff: FileDiffMetadata
  readonly status: Exclude<JinglerFileStatus, "clean" | "ignored" | "untracked">
}

const emptyReviewDiff = (path: string): FileDiffMetadata =>
  createPierreFileDiff({
    path,
    status: "modified",
    before: "",
    after: ""
  })

const reviewDiffForPath = (path: string, patch: string): FileDiffMetadata => {
  if (patch.trim().length === 0) return emptyReviewDiff(path)
  try {
    const canonicalPath = canonicalPierrePath(path)
    const parsed = parsePierreFileDiffs(patch)
    const exact = parsed.find(
      (candidate) =>
        canonicalPierrePath(candidate.name) === canonicalPath ||
        (candidate.prevName !== undefined &&
          canonicalPierrePath(candidate.prevName) === canonicalPath)
    )
    if (exact !== undefined) return exact

    // Story fixtures and API fallbacks can carry one valid patch under a
    // caller-owned path. Re-key the parsed metadata instead of falling back to
    // a second parser or rendering a misleading empty file.
    const first = parsed[0]
    if (first !== undefined) {
      return {
        ...first,
        name: canonicalPath,
        ...(first.type === "rename-pure" || first.type === "rename-changed"
          ? { type: "change" as const, prevName: undefined }
          : {}),
        cacheKey: pierreCacheKey("diff", first.cacheKey, canonicalPath)
      }
    }
  } catch {
    // A malformed/empty API patch must not take down the entire review. The
    // file remains navigable and can still carry header-level review metadata.
  }
  return emptyReviewDiff(path)
}

/** Convert the one filtered review set into Pierre metadata exactly once. */
export const createReviewCodeFiles = (
  files: readonly PrFileChange[],
  fileDiffs: readonly { readonly path: string; readonly diff: string }[]
): ReviewCodeFile[] => {
  const patchByPath = new Map(
    fileDiffs.map((entry) => [canonicalPierrePath(entry.path), entry.diff])
  )
  return files.map((file) => {
    const path = canonicalPierrePath(file.path)
    const fileDiff = reviewDiffForPath(path, patchByPath.get(path) ?? "")
    return {
      file,
      fileDiff,
      status: jinglerStatusFromPierreDiff(fileDiff)
    }
  })
}

const selectionId = (selection: JinglerLineSelection): string =>
  [
    selection.path,
    selection.side,
    selection.startLine,
    selection.endSide,
    selection.endLine
  ].join(":")

const annotationIdentity = (
  annotations: readonly { readonly metadata: PierreAnnotationMetadata }[]
): string => JSON.stringify(annotations.map((annotation) => annotation.metadata.payload))

export interface NewSideReviewRange {
  readonly startLine: number
  readonly endLine: number
}

/**
 * Draft and local-revert APIs currently accept NEW-file coordinates. Preserve
 * Pierre's side-aware selection in the UI, then translate a left-side range to
 * the new-side span of the hunk(s) it selected before crossing that boundary.
 */
export const newSideRangeForReviewSelection = (
  selection: JinglerLineSelection,
  fileDiff: FileDiffMetadata
): NewSideReviewRange | null => {
  if (selection.side === "new" && selection.endSide === "new") {
    return {
      startLine: Math.min(selection.startLine, selection.endLine),
      endLine: Math.max(selection.startLine, selection.endLine)
    }
  }

  const oldLines = [
    ...(selection.side === "old" ? [selection.startLine] : []),
    ...(selection.endSide === "old" ? [selection.endLine] : [])
  ]
  if (oldLines.length === 0) return null
  const oldStart = Math.min(...oldLines)
  const oldEnd = Math.max(...oldLines)
  const matchingHunks = fileDiff.hunks.filter((hunk) => {
    const hunkOldEnd =
      hunk.deletionStart + Math.max(hunk.deletionCount, 1) - 1
    return hunk.deletionStart <= oldEnd && hunkOldEnd >= oldStart
  })
  if (matchingHunks.length === 0) return null

  return {
    startLine: Math.min(...matchingHunks.map((hunk) => hunk.additionStart)),
    endLine: Math.max(
      ...matchingHunks.map(
        (hunk) => hunk.additionStart + Math.max(hunk.additionCount, 1) - 1
      )
    )
  }
}

export interface CreateReviewCodeItemsOptions {
  readonly entries: readonly ReviewCodeFile[]
  readonly drafts: readonly ReviewDraft[]
  readonly reviewThreads: readonly PrReviewThread[]
  readonly selection: JinglerLineSelection | null
  readonly collapseViewed: boolean
  readonly connected: boolean
  readonly routeTargetSession: string | null
}

/** Controlled CodeView items containing every persistent review annotation. */
export const createReviewCodeItems = ({
  entries,
  drafts,
  reviewThreads,
  selection,
  collapseViewed,
  connected,
  routeTargetSession
}: CreateReviewCodeItemsOptions): CodeViewItem<PierreAnnotationMetadata>[] => {
  const payloadsByPath = new Map<string, PierreAnnotationPayload[]>()
  const addPayload = (payload: PierreAnnotationPayload): void => {
    const annotation = createPierreDiffAnnotation(payload)
    if (annotation === null) return
    let payloadPath: string
    switch (payload.kind) {
      case "inline-composer":
      case "selected-range-actions":
        payloadPath = payload.selection.path
        break
      case "saved-draft":
        payloadPath = payload.draft.path
        break
      case "review-thread":
        payloadPath = payload.thread.path
        break
      case "finding":
        if (payload.finding.path === null) return
        payloadPath = payload.finding.path
        break
    }
    const path = canonicalPierrePath(payloadPath)
    payloadsByPath.set(path, [...(payloadsByPath.get(path) ?? []), payload])
  }

  if (selection !== null) {
    addPayload({
      id: `review-composer:${selectionId(selection)}`,
      kind: "inline-composer",
      selection,
      connected,
      routeTargetSession
    })
  }
  for (const draft of drafts) {
    addPayload({
      id: `review-draft:${draft.id}`,
      kind: "saved-draft",
      draft
    })
  }
  for (const thread of reviewThreads) {
    addPayload({
      id: `review-thread:${thread.id}`,
      kind: "review-thread",
      thread
    })
  }

  return entries.map(({ file, fileDiff }) => {
    const payloads = payloadsByPath.get(canonicalPierrePath(file.path)) ?? []
    const annotations = payloads.flatMap((payload) => {
      const annotation = createPierreDiffAnnotation(payload)
      return annotation === null ? [] : [annotation]
    })
    return createPierreCodeViewItem<PierreAnnotationMetadata>({
      type: "diff",
      id: canonicalPierrePath(file.path),
      fileDiff,
      annotations,
      collapsed: collapseViewed && file.viewed,
      version: pierreItemVersion(
        fileDiff.cacheKey,
        file.path,
        file.viewed ? 1 : 0,
        collapseViewed ? 1 : 0,
        annotationIdentity(annotations)
      )
    })
  })
}

interface ReviewCodeViewProps {
  readonly entries: readonly ReviewCodeFile[]
  readonly selection: JinglerLineSelection | null
  readonly scrollRequest: PierreCodeViewProps["scrollRequest"]
  readonly drafts: readonly ReviewDraft[]
  readonly reviewThreads: readonly PrReviewThread[]
  readonly findingsByPath: ReadonlyMap<string, readonly ReviewFinding[]>
  readonly review: AdversarialReview | null
  readonly sentFindingIds?: ReadonlySet<string>
  readonly connected: boolean
  readonly routeTargetSession: string | null
  readonly local: boolean
  readonly compactActions: boolean
  readonly collapseViewed: boolean
  readonly onSelectionChange: (selection: JinglerLineSelection | null) => void
  readonly onActivePathChange: (path: string) => void
  readonly onAddDraft: (draft: {
    path: string
    line: number
    endLine: number | null
    body: string
    routeToAgent: boolean
  }) => void
  readonly onRemoveDraft: (id: string) => void
  readonly onToggleViewed: (path: string, viewed: boolean) => void
  readonly onRevertLines?: (range: {
    path: string
    startLine: number
    endLine: number
  }) => void
  readonly onRevertFile?: (path: string) => void
  readonly onDeslopFile?: (path: string) => void
  readonly onSendFindingToAgent?: (findingId: string) => void
}

export function ReviewCodeView({
  entries,
  selection,
  scrollRequest,
  drafts,
  reviewThreads,
  findingsByPath,
  review,
  sentFindingIds,
  connected,
  routeTargetSession,
  local,
  compactActions,
  collapseViewed,
  onSelectionChange,
  onActivePathChange,
  onAddDraft,
  onRemoveDraft,
  onToggleViewed,
  onRevertLines,
  onRevertFile,
  onDeslopFile,
  onSendFindingToAgent
}: ReviewCodeViewProps) {
  const entryByPath = useMemo(
    () => new Map(entries.map((entry) => [canonicalPierrePath(entry.file.path), entry])),
    [entries]
  )
  const items = useMemo(
    () =>
      createReviewCodeItems({
        entries,
        drafts,
        reviewThreads,
        selection,
        collapseViewed,
        connected,
        routeTargetSession
      }),
    [
      collapseViewed,
      connected,
      drafts,
      entries,
      reviewThreads,
      routeTargetSession,
      selection
    ]
  )

  const clearSelection = useCallback(() => onSelectionChange(null), [onSelectionChange])

  const renderHeader = useCallback(
    (item: CodeViewItem<PierreAnnotationMetadata>): ReactNode => {
      const entry = entryByPath.get(item.id)
      if (entry === undefined) return null
      return (
        <ReviewCodeHeader
          file={entry.file}
          findings={findingsByPath.get(entry.file.path) ?? []}
          review={review}
          sentFindingIds={sentFindingIds}
          routeTargetSession={routeTargetSession}
          local={local}
          compactActions={compactActions}
          collapsed={collapseViewed && entry.file.viewed}
          onToggleViewed={(viewed) => {
            if (viewed && selection?.path === entry.file.path) clearSelection()
            onToggleViewed(entry.file.path, viewed)
          }}
          onRevertFile={
            onRevertFile === undefined
              ? undefined
              : () => {
                  if (selection?.path === entry.file.path) clearSelection()
                  onRevertFile(entry.file.path)
                }
          }
          onDeslopFile={
            onDeslopFile === undefined
              ? undefined
              : () => onDeslopFile(entry.file.path)
          }
          onSendFindingToAgent={onSendFindingToAgent}
        />
      )
    },
    [
      clearSelection,
      collapseViewed,
      compactActions,
      entryByPath,
      findingsByPath,
      local,
      onDeslopFile,
      onRevertFile,
      onSendFindingToAgent,
      onToggleViewed,
      review,
      routeTargetSession,
      selection?.path,
      sentFindingIds
    ]
  )

  const renderAnnotation = useCallback(
    (payload: PierreAnnotationPayload): ReactNode => {
      switch (payload.kind) {
        case "inline-composer": {
          const selected = payload.selection
          const selectedEntry = entryByPath.get(
            canonicalPierrePath(selected.path)
          )
          const newSideRange =
            selectedEntry === undefined
              ? null
              : newSideRangeForReviewSelection(selected, selectedEntry.fileDiff)
          const submit = (draft: { body: string; routeToAgent: boolean }) => {
            if (newSideRange === null) return
            onAddDraft({
              path: selected.path,
              line: newSideRange.startLine,
              endLine:
                newSideRange.endLine === newSideRange.startLine
                  ? null
                  : newSideRange.endLine,
              body: draft.body,
              routeToAgent: draft.routeToAgent
            })
            clearSelection()
          }
          return (
            <PierreAnnotationRegion
              label={`Comment on ${selected.path}`}
              payload={payload}
              className="px-4 py-3"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <InlineCommentComposer
                key={payload.id}
                path={selected.path}
                side={selected.endSide}
                startLine={selected.startLine}
                endLine={selected.endLine}
                connected={payload.connected}
                routeTargetSession={payload.routeTargetSession}
                initialBody={payload.initialBody}
                onCancel={clearSelection}
                onAddToReview={submit}
                onCommentAndSend={submit}
                onRevert={
                  local && onRevertLines !== undefined && newSideRange !== null
                    ? () => {
                        onRevertLines({
                          path: selected.path,
                          startLine: newSideRange.startLine,
                          endLine: newSideRange.endLine
                        })
                        clearSelection()
                      }
                    : undefined
                }
              />
            </PierreAnnotationRegion>
          )
        }
        case "saved-draft":
          return (
            <SavedDraftAnnotation
              payload={payload}
              onRemove={() => onRemoveDraft(payload.draft.id)}
            />
          )
        case "review-thread":
          return (
            <PierreAnnotationRegion
              label={`Review thread on ${payload.thread.path}`}
              payload={payload}
              className="px-3 py-2"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <PrReviewThreadView thread={payload.thread} inline />
            </PierreAnnotationRegion>
          )
        case "finding":
        case "selected-range-actions":
          return null
      }
    },
    [
      clearSelection,
      entryByPath,
      local,
      onAddDraft,
      onRemoveDraft,
      onRevertLines
    ]
  )

  return (
    <PierreCodeView
      label="Code review changes"
      className="h-full min-h-0 min-w-0 flex-1"
      items={items}
      selection={selection}
      onSelectionChange={onSelectionChange}
      scrollRequest={scrollRequest}
      onActivePathChange={onActivePathChange}
      renderHeader={renderHeader}
      renderAnnotation={renderAnnotation}
      options={{
        diffStyle: "unified",
        stickyHeader: true,
        hunkSeparators: "line-info"
      }}
    />
  )
}

function ReviewCodeHeader({
  file,
  findings,
  review,
  sentFindingIds,
  routeTargetSession,
  local,
  compactActions,
  collapsed,
  onToggleViewed,
  onRevertFile,
  onDeslopFile,
  onSendFindingToAgent
}: {
  readonly file: PrFileChange
  readonly findings: readonly ReviewFinding[]
  readonly review: AdversarialReview | null
  readonly sentFindingIds?: ReadonlySet<string>
  readonly routeTargetSession: string | null
  readonly local: boolean
  readonly compactActions: boolean
  readonly collapsed: boolean
  readonly onToggleViewed: (viewed: boolean) => void
  readonly onRevertFile?: () => void
  readonly onDeslopFile?: () => void
  readonly onSendFindingToAgent?: (findingId: string) => void
}) {
  const viewedLabel = collapsed
    ? "Viewed · code collapsed"
    : `${file.viewed ? "Mark not viewed" : "Mark viewed"}: ${file.path}`
  return (
    <div
      className="flex min-w-0 flex-col bg-panel text-text-body"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 px-3 py-1.5">
        <FileIcon path={file.path} size={13} />
        <span className="min-w-[8rem] flex-1 truncate font-mono text-[12.5px] text-text-bright">
          {file.path}
        </span>
        <DiffStat
          added={file.additions}
          removed={file.deletions}
          className="flex-none text-[10.5px]"
        />
        {onDeslopFile && (
          <Button
            variant="secondary"
            size="icon"
            className="size-10"
            title="Deslop — hand this file to the agent for a DRY / cleanup pass"
            onClick={onDeslopFile}
          >
            <BrushCleaning size={15} />
            <span className="sr-only">Deslop</span>
          </Button>
        )}
        {local && onRevertFile && (
          <Button
            variant="danger"
            size="sm"
            className={cn("min-h-10 gap-1.5", compactActions && "size-10 p-0")}
            onClick={onRevertFile}
          >
            <Undo2 size={13} />
            <span className={cn(compactActions && "sr-only")}>Revert file</span>
          </Button>
        )}
        <button
          type="button"
          aria-pressed={file.viewed}
          aria-label={viewedLabel}
          onClick={() => onToggleViewed(!file.viewed)}
          className="flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-text transition-[background-color,scale] duration-150 ease-out hover:bg-surface active:scale-[0.96]"
        >
          {collapsed ? (
            <EyeOff size={13} />
          ) : (
            <span
              className={
                file.viewed
                  ? "flex size-[15px] items-center justify-center rounded-[3px] border border-green/60 text-green"
                  : "size-[15px] rounded-[3px] border border-line"
              }
            >
              {file.viewed && "✓"}
            </span>
          )}
          <span className={cn(compactActions && "sr-only")}>
            {collapsed ? "Viewed · code collapsed" : "Viewed"}
          </span>
        </button>
      </div>
      {findings.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-hairline bg-panel/40 px-4 py-3">
          {findings.map((finding) => (
            <ReviewFindingRow
              key={finding.id}
              finding={finding}
              sent={sentFindingIds?.has(finding.id) ?? false}
              canRoute={routeTargetSession !== null}
              review={review}
              onSendToAgent={onSendFindingToAgent}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SavedDraftAnnotation({
  payload,
  onRemove
}: {
  readonly payload: Extract<PierreAnnotationPayload, { kind: "saved-draft" }>
  readonly onRemove: () => void
}) {
  const { draft } = payload
  const range =
    draft.endLine !== null && draft.endLine > draft.line
      ? `L${draft.line}–${draft.endLine}`
      : `L${draft.line}`
  return (
    <PierreAnnotationRegion
      label={`Saved draft on ${draft.path} ${range}`}
      payload={payload}
      className="flex max-w-[680px] flex-col gap-2 px-4 py-3"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] text-blue">Pending review · {range}</span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Remove comment"
          onClick={onRemove}
          className="text-dim hover:text-red"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p className="text-[12.5px] leading-[1.5] text-text">{draft.body}</p>
    </PierreAnnotationRegion>
  )
}
