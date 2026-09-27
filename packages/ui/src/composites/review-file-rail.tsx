import type { PrFileChange } from "@jingler/core"
import { EyeOff, MessageSquare, Search } from "lucide-react"
import { DiffStat } from "../components/diff-stat.js"
import type { JinglerFileStatus } from "../diff/pierre-model.js"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/beui/select.js"
import { cn } from "../lib/cn.js"
import type { ReviewFileKind } from "./code-review-view-machine.js"
import { ReviewFileTree } from "./review-file-tree.js"
import type { useCodeReviewView } from "./use-code-review-view.js"

const REVIEW_KIND_OPTIONS: ReadonlyArray<{
  readonly value: ReviewFileKind
  readonly label: string
}> = [
  { value: "all", label: "All files" },
  { value: "code", label: "Code" },
  { value: "tests", label: "Tests" },
  { value: "json", label: "JSON" },
  { value: "docs", label: "Docs" },
  { value: "styles", label: "Styles" }
]

export function ReviewFileRail({
  files,
  totalFiles,
  activePath,
  feedback,
  feedbackAny,
  statusByPath,
  added,
  removed,
  viewed,
  controls,
  onSelectFile
}: {
  readonly files: readonly PrFileChange[]
  readonly totalFiles: number
  readonly activePath: string | null
  readonly feedback: ReadonlyMap<string, number>
  readonly feedbackAny: boolean
  readonly statusByPath: ReadonlyMap<string, JinglerFileStatus>
  readonly added: number
  readonly removed: number
  readonly viewed: number
  readonly controls: ReturnType<typeof useCodeReviewView>
  readonly onSelectFile: (path: string) => void
}) {
  return (
    <>
      <div className="flex h-[42px] flex-none items-center gap-2 border-b border-hairline px-[14px]">
        <span className="flex-1 text-[12px] font-semibold text-text-bright">
          Changed files
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {files.length} / {totalFiles}
        </span>
      </div>
      <div className="flex flex-none flex-col gap-2 border-b border-hairline p-2">
        {/* Dressed exactly like the sidebar's session search (`TitleSearch`). */}
        <label className="flex h-[30px] items-center gap-2.5 rounded-lg border border-hairline bg-sunken px-3 text-[13px] text-dim transition-colors hover:border-line focus-within:border-line focus-within:ring-2 focus-within:ring-ring">
          <Search size={14} aria-hidden className="flex-none" />
          <input
            type="search"
            value={controls.query}
            onChange={(event) => controls.setQuery(event.currentTarget.value)}
            aria-label="Search changed files"
            placeholder="Search files…"
            className="min-w-0 flex-1 bg-transparent text-text-body outline-none placeholder:text-dim"
          />
        </label>
        <div className="flex items-center gap-1.5">
          <Select
            value={controls.kind}
            onValueChange={(value) => controls.setKind(value as ReviewFileKind)}
          >
            <SelectTrigger
              className="h-[30px] min-w-0 flex-1 rounded-lg text-[12px]"
              aria-label="Filter changed files by type"
            >
              <SelectValue />
            </SelectTrigger>
            {/* Wider than the trigger so no option wraps. */}
            <SelectContent className="right-auto w-[168px]">
              {REVIEW_KIND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            aria-pressed={controls.collapseViewed}
            aria-label="Collapse viewed files"
            title={
              controls.collapseViewed
                ? "Keep viewed code collapsed"
                : "Keep viewed code expanded"
            }
            onClick={controls.toggleCollapseViewed}
            className={cn(
              "flex size-[30px] flex-none items-center justify-center rounded-lg border bg-sunken transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.96]",
              controls.collapseViewed
                ? "border-blue/40 bg-blue/[0.12] text-blue"
                : "border-line text-dim hover:border-line-strong hover:text-text"
            )}
          >
            <EyeOff size={14} />
          </button>
        </div>
        {feedbackAny && (
          <button
            type="button"
            aria-pressed={controls.feedbackOnly}
            title={
              controls.feedbackOnly
                ? "Show all files"
                : "Show only files with feedback"
            }
            onClick={controls.toggleFeedback}
            className={cn(
              "flex min-h-[30px] items-center justify-center gap-1.5 rounded-lg border bg-sunken px-2.5 text-[11px] transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.96]",
              controls.feedbackOnly
                ? "border-blue/40 bg-blue/[0.14] text-blue"
                : "border-line text-dim hover:border-line-strong hover:text-text"
            )}
          >
            <MessageSquare size={12} strokeWidth={2.25} />
            With feedback
            <span className="font-mono text-[10px] tabular-nums leading-none">
              {feedback.size}
            </span>
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-1.5">
        <ReviewFileTree
          files={files}
          activePath={activePath}
          statusByPath={statusByPath}
          query={controls.query}
          onSelectFile={onSelectFile}
        />
      </div>
      <div className="flex h-11 flex-none items-center gap-1.5 border-t border-hairline px-[14px] font-mono text-[10.5px] text-dim">
        <DiffStat added={added} removed={removed} className="text-[10.5px]" />
        <div className="flex-1" />
        <span className="tabular-nums">
          {viewed} / {files.length} viewed
        </span>
      </div>
    </>
  )
}
