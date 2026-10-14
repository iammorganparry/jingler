import type { ReactNode } from "react"
import type { PullRequest } from "@jingler/core"
import { Check } from "lucide-react"
import { Card, CardHeader } from "../components/card.js"
import { StatusRow } from "../components/status-row.js"

interface ReadinessRow {
  readonly id: "git" | "ci" | "threads" | "todos" | "description"
  readonly label: string
  /** Satisfied rows get a check; open ones keep the neutral dot. */
  readonly done: boolean
  /** Only a failing check or a conflict goes red (spec §6.3). */
  readonly failed?: boolean
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

function gitRow(pr: PullRequest): ReadinessRow {
  if (pr.mergeable === "CONFLICTING") return { id: "git", label: `Conflicts with ${pr.baseRefName}`, done: false, failed: true }
  if (pr.mergeStateStatus === "BEHIND") return { id: "git", label: `Behind ${pr.baseRefName}`, done: false }
  return { id: "git", label: `No conflicts with ${pr.baseRefName}`, done: true }
}

function ciRow(pr: PullRequest): ReadinessRow {
  const failing = pr.checks.filter((c) => c.status === "fail").length
  const unfinished = pr.checks.filter((c) => c.status === "running" || c.status === "pending").length
  if (pr.checks.length === 0) return { id: "ci", label: "No checks reported", done: false }
  if (failing > 0) return { id: "ci", label: `${failing} of ${plural(pr.checks.length, "check")} failing`, done: false, failed: true }
  if (unfinished > 0) return { id: "ci", label: `${plural(unfinished, "check")} still running`, done: false }
  return { id: "ci", label: `All ${plural(pr.checks.length, "check")} passed`, done: true }
}

/** Unchecked `- [ ]` task items in the PR description. */
export const openTodoCount = (body: string | null): number => (body?.match(/^\s*[-*] \[ \]/gm) ?? []).length

/** The five readiness questions a PR must answer before merge, in display order. */
export function readinessRows(pr: PullRequest): ReadonlyArray<ReadinessRow> {
  const unresolved = pr.reviewThreads.filter((t) => !t.isResolved).length
  const todos = openTodoCount(pr.body)
  const hasBody = pr.body !== null && pr.body.trim().length > 0
  return [
    gitRow(pr),
    ciRow(pr),
    {
      id: "threads",
      label: unresolved === 0 ? "All review threads resolved" : `${plural(unresolved, "unresolved review thread")}`,
      done: unresolved === 0
    },
    { id: "todos", label: todos === 0 ? "No open todos" : plural(todos, "open todo"), done: todos === 0 },
    { id: "description", label: hasBody ? "Description added" : "No description", done: hasBody }
  ]
}

/** Readiness checklist: one neutral StatusRow per merge-readiness question. */
export function ReadinessChecklist({ pr }: { pr: PullRequest }): ReactNode {
  return (
    <section aria-label="Readiness">
      <Card>
        <CardHeader title="Readiness" />
        <div className="flex flex-col gap-2 px-[13px] py-3">
          {readinessRows(pr).map((row) => (
            <StatusRow key={row.id} failed={row.failed} icon={row.done ? <Check size={14} /> : undefined}>
              {row.label}
            </StatusRow>
          ))}
        </div>
      </Card>
    </section>
  )
}
