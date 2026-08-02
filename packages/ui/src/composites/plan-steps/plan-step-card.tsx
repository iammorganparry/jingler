import { type ReactNode, useMemo } from "react"
import {
  type PlanAcceptance,
  type PlanStageComplexity,
  type PlanStageExecutionStatus,
  type PlanStepView,
  sanitizePlanHtml
} from "@jingler/core"
import { Check, Circle, MinusCircle, X } from "lucide-react"
import { Badge } from "../../components/badge.js"
import { FileChip } from "../../components/file-chip.js"
import { StatusDot } from "../../components/status-dot.js"
import { cn } from "../../lib/cn.js"
import { usePlanFileControls } from "../plan-doc/plan-file-controls.js"

/**
 * Step-based outline card (design screen 04). One digestible card per plan step,
 * built entirely from `PlanStepView` — the pure `@jingler/core` projection — so
 * the whole outline is testable without a live plan document.
 *
 * A card carries three scannable sections: **Changes** (the step's declared file
 * edits, as thin inline `FileChip`s with diff evidence), **Tasks** (the step's
 * one-line `intent` plus its sanitized approach prose), and **Tests** (each
 * acceptance criterion with its status and any recorded evidence).
 *
 * Selection is the whole card: clicking (or activating with the keyboard) calls
 * `onSelect(step.id)`, and `active` paints the selected state. A stable
 * `data-step-id` lets sibling surfaces (e.g. the Workflow graph) cross-link to a
 * specific card.
 */

/** Planner complexity estimate -> tinted chip tone. */
const COMPLEXITY_TONE: Record<PlanStageComplexity, "blue" | "yellow" | "red"> = {
  low: "blue",
  medium: "yellow",
  high: "red"
}

/** Durable worker state -> a status dot tone + label colour + motion. */
const EXECUTION_META: Record<
  PlanStageExecutionStatus,
  { readonly dot: string; readonly text: string; readonly label: string; readonly pulse?: boolean }
> = {
  queued: { dot: "bg-line-strong", text: "text-dim", label: "Queued" },
  running: { dot: "bg-blue", text: "text-blue", label: "Running", pulse: true },
  blocked: { dot: "bg-yellow", text: "text-yellow", label: "Blocked" },
  failed: { dot: "bg-red", text: "text-red", label: "Failed" },
  interrupted: { dot: "bg-yellow", text: "text-muted-foreground", label: "Interrupted" },
  completed: { dot: "bg-green", text: "text-green", label: "Completed" }
}

/** Acceptance status -> icon + token colour (per Stage 04 spec). */
const ACCEPTANCE_META: Record<
  PlanAcceptance["status"],
  { readonly Icon: typeof Check; readonly text: string; readonly label: string }
> = {
  passed: { Icon: Check, text: "text-green", label: "Passed" },
  failed: { Icon: X, text: "text-red", label: "Failed" },
  pending: { Icon: Circle, text: "text-dim", label: "Pending" },
  waived: { Icon: MinusCircle, text: "text-muted-foreground", label: "Waived" }
}

const CHANGE_BORDER: Record<PlanStepView["files"][number]["change"], string | undefined> = {
  A: "border-green/40",
  M: undefined,
  D: "border-red/40"
}

/**
 * Cap how many file chips a card renders. A stage can touch hundreds of files;
 * beyond this the row becomes noise, so the rest collapse into a "+N more" chip.
 */
const MAX_VISIBLE_FILES = 12

/**
 * Sanitize the stage body and drop blocks that are already surfaced elsewhere on
 * the card: the `<ul data-files>` declaration (rendered as `FileChip`s in the
 * Changes section), the `[data-acceptance]` criteria (the Tests section), the
 * `[data-assignment]` worker metadata, and any embedded mermaid diagrams (an
 * Architecture-surface concern). Mirrors `plan-architecture`'s `sectionProse`.
 */
const taskProse = (markdown: string): string => {
  const html = sanitizePlanHtml(markdown)
  if (typeof DOMParser === "undefined") return html
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const el of doc.querySelectorAll(
    "ul[data-files], [data-acceptance], [data-assignment], [data-diagram]"
  ))
    el.remove()
  // The stage's `intent` is rendered in its own slot above the prose, and the
  // plan dialect also carries it as an "Intent" heading + paragraph in the body.
  // Drop that heading (and the paragraph it introduces) so it isn't shown twice.
  for (const heading of doc.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (heading.textContent?.trim().toLowerCase() !== "intent") continue
    const next = heading.nextElementSibling
    heading.remove()
    if (next?.tagName === "P") next.remove()
  }
  return doc.body.innerHTML.trim()
}

export interface PlanStepCardProps {
  readonly step: PlanStepView
  /** Renders the selected state and marks the card current. */
  readonly active?: boolean
  /** Fired when the card is clicked or activated with the keyboard. */
  readonly onSelect?: (stepId: string) => void
}

export function PlanStepCard({ step, active, onSelect }: PlanStepCardProps) {
  const body = useMemo(() => taskProse(step.markdown), [step.markdown])
  // Live worktree evidence + open handler come from the plan file-controls
  // context (provided around the outline), so chips open the asset and show
  // live +/- while there's uncommitted work — falling back to declared counts.
  const fileControls = usePlanFileControls()
  const exec = EXECUTION_META[step.executionStatus]
  const select = () => onSelect?.(step.id)

  return (
    // biome-ignore lint/a11y/useSemanticElements: an outer <button> can't wrap the card's own interactive descendants; role+keyboard handler keep it accessible
    <div
      data-step-id={step.id}
      data-stage={step.id}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          select()
        }
      }}
      className={cn(
        "group flex cursor-pointer flex-col gap-3.5 rounded-lg border bg-panel px-4 py-3.5 text-left",
        "transition-[background-color,border-color] duration-150 ease-out outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-blue/55 bg-blue/[0.06]"
          : "border-hairline hover:border-line-strong hover:bg-surface/50"
      )}
    >
      {/* Header: step id marker + title, complexity chip, execution status */}
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
          {step.id}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 text-[13px] font-semibold leading-[1.4]",
            active ? "text-text-bright" : "text-text"
          )}
        >
          {step.title}
        </span>
        {step.complexity && (
          <Badge tone={COMPLEXITY_TONE[step.complexity]} size="xs" className="mt-px flex-none uppercase">
            {step.complexity}
          </Badge>
        )}
        <span className={cn("mt-px flex flex-none items-center gap-1.5 text-[10.5px] font-medium", exec.text)}>
          <StatusDot tone={exec.dot} size={7} pulse={exec.pulse} glow={exec.pulse} />
          {exec.label}
        </span>
      </div>

      {/* Changes */}
      <CardSection title="Changes" count={step.files.length}>
        {step.files.length === 0 ? (
          <EmptyNote>No file changes declared.</EmptyNote>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {step.files.slice(0, MAX_VISIBLE_FILES).map((file) => {
              const evidence = fileControls.evidence?.get(file.path)
              const openable =
                fileControls.open !== undefined &&
                (fileControls.knownFiles === undefined ||
                  fileControls.knownFiles.has(file.path) ||
                  evidence !== undefined ||
                  file.added + file.removed > 0)
              return (
                <FileChip
                  key={`${file.change}-${file.path}`}
                  path={file.path}
                  // Live evidence wins while it exists; declared counts remain
                  // once the work is committed and evidence collapses to 0.
                  added={evidence?.added || file.added}
                  removed={evidence?.removed || file.removed}
                  onOpen={openable ? fileControls.open : undefined}
                  className={CHANGE_BORDER[file.change]}
                />
              )
            })}
            {step.files.length > MAX_VISIBLE_FILES && (
              <span
                className="inline-flex h-[22px] flex-none items-center rounded-[5px] border border-line/70 bg-surface/40 px-2 font-mono text-[10.5px] text-muted-foreground"
                title={`${step.files.length - MAX_VISIBLE_FILES} more changed files`}
              >
                +{step.files.length - MAX_VISIBLE_FILES} more
              </span>
            )}
          </div>
        )}
      </CardSection>

      {/* Tasks: intent + approach prose */}
      <CardSection title="Tasks">
        {step.intent.trim().length > 0 && (
          <p className="m-0 text-[12.5px] leading-[1.55] text-text-body">{step.intent}</p>
        )}
        {body.length > 0 && (
          <div
            className="sb-md text-[12.5px] leading-[1.6] text-text-body"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitizePlanHtml allowlist strips scripts/handlers/inline styles before render
            dangerouslySetInnerHTML={{ __html: body }}
          />
        )}
        {step.intent.trim().length === 0 && body.length === 0 && (
          <EmptyNote>No task detail yet.</EmptyNote>
        )}
      </CardSection>

      {/* Tests: acceptance criteria */}
      <CardSection title="Tests" count={step.acceptance.length}>
        {step.acceptance.length === 0 ? (
          <EmptyNote>No acceptance criteria yet.</EmptyNote>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {step.acceptance.map((criterion) => {
              const meta = ACCEPTANCE_META[criterion.status]
              const { Icon } = meta
              return (
                <li key={criterion.id} className="flex flex-col gap-1">
                  <div className="flex items-start gap-2 text-[12px] leading-[1.5]">
                    <Icon className={cn("mt-0.5 size-3.5 flex-none", meta.text)} strokeWidth={2.25} />
                    <span className="min-w-0 flex-1 text-text-body">{criterion.text}</span>
                    <span className={cn("flex-none text-[9.5px] font-medium uppercase tracking-wide", meta.text)}>
                      {meta.label}
                    </span>
                  </div>
                  {criterion.evidence && (
                    <p className="m-0 pl-[22px] text-[11px] leading-[1.5] text-muted-foreground">
                      {criterion.evidence}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardSection>
    </div>
  )
}

function CardSection({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="m-0 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
        {title}
        {count !== undefined && count > 0 && (
          <span className="font-mono text-[9px] text-dim tabular-nums">{count}</span>
        )}
      </h4>
      {children}
    </section>
  )
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[11.5px] text-dim">{children}</p>
}
