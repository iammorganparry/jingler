import { useMemo } from "react"
import type { PlanStep } from "@jingler/core"
import { FileDiff } from "lucide-react"
import { cn } from "../lib/cn.js"
import { DiffView } from "../diff/diff-view.js"
import { canonicalPierrePath } from "../diff/pierre-model.js"
import { parsePierreFileDiffs } from "../diff/parse.js"

/**
 * The right rail of Plan Review: the *actual* file changes the agent has made for
 * the selected step (sliced from the session worktree's live diff). Empty until
 * execution touches one of the step's files — so a completed step shows its real
 * diff right beside its spec.
 */
export function PlanStepChanges({
  step,
  patch,
  className
}: {
  step: PlanStep
  patch: string
  className?: string
}) {
  const paths = useMemo(() => step.files.map((f) => f.path), [step.files])
  const fileDiffs = useMemo(() => {
    if (patch.trim().length === 0 || paths.length === 0) return []
    const wanted = new Set(paths.map(canonicalPierrePath))
    return parsePierreFileDiffs(patch).filter(
      (fileDiff) =>
        wanted.has(canonicalPierrePath(fileDiff.name)) ||
        (fileDiff.prevName !== undefined &&
          wanted.has(canonicalPierrePath(fileDiff.prevName)))
    )
  }, [patch, paths])
  const hasChanges = fileDiffs.length > 0

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-panel", className)}>
      <div className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2.5">
        <FileDiff className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">
          Changes in this step
        </span>
        {step.status === "done" && (
          <span className="ml-auto text-[10px] font-medium text-green">done</span>
        )}
      </div>
      {hasChanges ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffView fileDiffs={fileDiffs} label={`Changes in ${step.title}`} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <FileDiff className="size-6 text-line-strong" />
          <p className="m-0 text-[12px] text-muted-foreground">
            {step.files.length === 0 ? "This step touches no files." : "No changes yet for this step."}
          </p>
          {step.files.length > 0 && (
            <p className="m-0 text-[11px] text-line-strong">Its diff appears here once the agent edits these files.</p>
          )}
        </div>
      )}
    </div>
  )
}
