import type { PrFileChange } from "@jingler/core"
import { MessageSquare } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Checkbox } from "../components/checkbox.js"
import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"

/**
 * A row in the Code Review file list — name, diff stat, feedback marker, viewed
 * state.
 *
 * `feedback` counts everything on this file worth looking at: adversarial
 * findings, your unsubmitted drafts, and unresolved PR threads. It replaces
 * `file.commentCount`, which every producer hardcoded to 0 — the badge it fed
 * could never render.
 */
export function ReviewFileRow({
  file,
  active,
  feedback = 0,
  onSelect,
  onToggleViewed
}: {
  file: PrFileChange
  active: boolean
  /** How many pieces of feedback sit on this file. 0 renders no marker. */
  feedback?: number
  onSelect: () => void
  onToggleViewed: (viewed: boolean) => void
}) {
  const name = file.path.split("/").pop() ?? file.path
  return (
    <div
      className={cn(
        "flex min-h-10 items-center rounded-md border transition-[background-color,border-color,opacity] duration-150 ease-out",
        active ? "border-blue/[0.28] bg-surface" : "border-transparent hover:bg-surface/40",
        !active && file.viewed && "opacity-70"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left outline-none transition-[scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-blue/60 active:scale-[0.96]"
      >
        <FileIcon path={file.path} size={13} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
            active ? "text-text-bright" : "text-text"
          )}
          title={file.path}
        >
          {name}
        </span>
        <DiffStat added={file.additions} removed={file.deletions} className="flex-none text-[9.5px]" />
        {feedback > 0 && (
          // Icon + count rather than a bare number: at this size a lone digit
          // beside the +/− stat reads as another diff figure. The icon says what
          // kind of number it is before you've read it.
          <span
            className="flex flex-none items-center gap-[3px] text-blue"
            title={`${feedback} ${feedback === 1 ? "comment" : "comments"}`}
          >
            <MessageSquare size={11} strokeWidth={2.25} />
            <span className="font-mono text-[9.5px] tabular-nums leading-none">{feedback}</span>
          </span>
        )}
      </button>
      {/* Padded wrapper keeps a comfortable hit target on a min-h-10 row while
          the box itself stays at the shadcn default size. */}
      <div className="flex flex-none items-center self-stretch pl-1.5 pr-2.5">
        <Checkbox
          tone="success"
          checked={file.viewed}
          onCheckedChange={(next) => onToggleViewed(next)}
          aria-label={file.viewed ? "Mark not viewed" : "Mark viewed"}
        />
      </div>
    </div>
  )
}
