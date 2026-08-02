import type { AdversarialReview, PrFileChange, ReviewFinding } from "@jingler/core"
import { EyeOff, Sparkles, Undo2 } from "lucide-react"
import { Button } from "../components/button.js"
import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"
import { cn } from "../lib/cn.js"
import { DeferredSection } from "./deferred-section.js"
import { ReviewDiff } from "./review-diff.js"
import { ReviewFindingRow } from "./review-findings.js"

export function ReviewFileSection({
  file,
  diff,
  estimatedHeight,
  active,
  connected,
  routeTargetSession,
  local,
  compactActions,
  collapseViewed,
  findings,
  review,
  sentFindingIds,
  onAddDraft,
  onToggleViewed,
  onRevertLines,
  onRevertFile,
  onDeslopFile,
  onSendFindingToAgent
}: {
  readonly file: PrFileChange
  readonly diff: string
  readonly estimatedHeight: number
  readonly active: boolean
  readonly connected: boolean
  readonly routeTargetSession: string | null
  readonly local: boolean
  readonly compactActions: boolean
  readonly collapseViewed: boolean
  readonly findings: readonly ReviewFinding[]
  readonly review: AdversarialReview | null
  readonly sentFindingIds?: ReadonlySet<string>
  readonly onAddDraft: (draft: {
    path: string
    line: number
    endLine: number | null
    body: string
    routeToAgent: boolean
  }) => void
  readonly onToggleViewed: (path: string, viewed: boolean) => void
  readonly onRevertLines?: (range: {
    path: string
    startLine: number
    endLine: number
  }) => void
  readonly onRevertFile?: (path: string) => void
  readonly onDeslopFile?: (path: string) => void
  readonly onSendFindingToAgent?: (findingId: string) => void
}) {
  return (
    <>
      <div className="sticky top-0 z-10 flex min-h-11 flex-none flex-wrap items-center gap-2 border-b border-hairline bg-panel px-3 py-1.5">
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
            size="sm"
            className={cn("min-h-10 gap-1.5", compactActions && "size-10 p-0")}
            title="Deslop — hand this file to the agent for a DRY / cleanup pass"
            onClick={() => onDeslopFile(file.path)}
          >
            <Sparkles size={13} />
            <span className={cn(compactActions && "sr-only")}>Deslop</span>
          </Button>
        )}
        {local && onRevertFile && (
          <Button
            variant="danger"
            size="sm"
            className={cn("min-h-10 gap-1.5", compactActions && "size-10 p-0")}
            onClick={() => onRevertFile(file.path)}
          >
            <Undo2 size={13} />
            <span className={cn(compactActions && "sr-only")}>Revert file</span>
          </Button>
        )}
        <button
          type="button"
          aria-pressed={file.viewed}
          aria-label={`${file.viewed ? "Mark not viewed" : "Mark viewed"}: ${file.path}`}
          onClick={() => onToggleViewed(file.path, !file.viewed)}
          className="flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-text transition-[background-color,scale] duration-150 ease-out hover:bg-surface active:scale-[0.96]"
        >
          <span
            className={
              file.viewed
                ? "flex size-[15px] items-center justify-center rounded-[3px] border border-green/60 text-green"
                : "size-[15px] rounded-[3px] border border-line"
            }
          >
            {file.viewed && "✓"}
          </span>
          <span className={cn(compactActions && "sr-only")}>Viewed</span>
        </button>
      </div>
      {findings.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-hairline bg-panel/40 px-4 py-3">
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
      {collapseViewed && file.viewed ? (
        <button
          type="button"
          onClick={() => onToggleViewed(file.path, false)}
          className="flex min-h-12 items-center justify-center gap-2 border-b border-hairline bg-panel/20 px-4 text-[11.5px] text-dim transition-[background-color,color] duration-150 ease-out hover:bg-panel/40 hover:text-text"
        >
          <EyeOff size={13} />
          Viewed · code collapsed
        </button>
      ) : (
        <DeferredSection estimatedHeight={estimatedHeight} pinned={active}>
          <ReviewDiff
            path={file.path}
            diff={diff}
            scroll={false}
            connected={connected}
            routeTargetSession={routeTargetSession}
            onAddDraft={(draft) =>
              onAddDraft({
                path: draft.path,
                line: draft.startLine,
                endLine: draft.endLine > draft.startLine ? draft.endLine : null,
                body: draft.body,
                routeToAgent: draft.routeToAgent
              })
            }
            onRevert={local ? onRevertLines : undefined}
          />
        </DeferredSection>
      )}
    </>
  )
}
