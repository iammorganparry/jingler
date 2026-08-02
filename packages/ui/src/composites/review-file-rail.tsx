import type { PrFileChange } from "@jingler/core"
import { EyeOff, MessageSquare, Search } from "lucide-react"
import { DiffStat } from "../components/diff-stat.js"
import { Input } from "../components/input.js"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/select.js"
import { cn } from "../lib/cn.js"
import type { ReviewFileKind } from "./code-review-view-machine.js"
import { ReviewFileRow } from "./review-file-row.js"
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
  added,
  removed,
  viewed,
  controls,
  onSelectFile,
  onToggleViewed
}: {
  readonly files: readonly PrFileChange[]
  readonly totalFiles: number
  readonly activePath: string | null
  readonly feedback: ReadonlyMap<string, number>
  readonly feedbackAny: boolean
  readonly added: number
  readonly removed: number
  readonly viewed: number
  readonly controls: ReturnType<typeof useCodeReviewView>
  readonly onSelectFile: (path: string) => void
  readonly onToggleViewed: (path: string, viewed: boolean) => void
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
        <div className="relative">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim"
          />
          <Input
            type="search"
            value={controls.query}
            onChange={(event) => controls.setQuery(event.currentTarget.value)}
            aria-label="Search changed files"
            placeholder="Search files…"
            className="h-10 pl-8"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            value={controls.kind}
            onValueChange={(value) => controls.setKind(value as ReviewFileKind)}
          >
            <SelectTrigger
              className="h-10 min-w-0 flex-1"
              aria-label="Filter changed files by type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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
              "flex size-10 flex-none items-center justify-center rounded-md border bg-sunken transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.96]",
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
              "flex min-h-10 items-center justify-center gap-1.5 rounded-md border bg-sunken px-2.5 text-[11px] transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.96]",
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
      <div className="flex flex-1 flex-col gap-px overflow-auto p-2">
        {files.map((file) => (
          <ReviewFileRow
            key={file.path}
            file={file}
            active={file.path === activePath}
            feedback={feedback.get(file.path) ?? 0}
            onSelect={() => onSelectFile(file.path)}
            onToggleViewed={(next) => onToggleViewed(file.path, next)}
          />
        ))}
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
