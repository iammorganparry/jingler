import { useEffect } from "react"
import { useMachine } from "@xstate/react"
import type { PullRequest } from "@jingler/core"
import { X } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { EmptyState, InlineError, InlineStatus } from "../components/feedback.js"
import { Pill } from "../components/pill.js"
import { loadDecisions, promotionSummary, reviewDrawerMachine, saveDecisions, undecidedDrafts, type ReviewFindingDraft, type ReviewRunStatus } from "./review-drawer-machine.js"

/** The live read-only review behind the drawer: started on first open, retried on failure. */
export interface ReviewRun {
  /** `repo#number` — decisions are remembered per key across PR switches. */
  readonly key: string
  readonly status: ReviewRunStatus
  readonly error?: string
  readonly onStart: () => void
}

/**
 * Drawer state for the PR view. Enabled only when `drafts` is supplied (the PR was opened
 * from the sidebar inbox). ⌘⇧R toggles; Esc closes.
 */
export function useReviewDrawer(drafts: ReadonlyArray<ReviewFindingDraft> | undefined, run?: ReviewRun) {
  const [snapshot, send] = useMachine(reviewDrawerMachine, { input: run ? loadDecisions(run.key) : {} })
  const enabled = drafts !== undefined
  const open = !snapshot.matches("closed")
  useEffect(() => {
    send({ type: "SET_DRAFTS", drafts: drafts ?? [] })
  }, [drafts, send])
  useEffect(() => {
    if (run) send({ type: "RUN", status: run.status, ...(run.error ? { error: run.error } : {}) })
  }, [run?.status, run?.error, send])
  useEffect(() => {
    if (run) saveDecisions(run.key, snapshot.context)
  }, [run?.key, snapshot.context.added, snapshot.context.dismissed])
  useEffect(() => {
    if (open && run?.status === "idle" && drafts?.length === 0) run.onStart()
  }, [open, run?.status])
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) send({ type: "CLOSE" })
      else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "r") {
        event.preventDefault()
        send({ type: "TOGGLE" })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, open, send])
  return { enabled, open, context: snapshot.context, send, retry: run?.onStart }
}

export type ReviewDrawerState = ReturnType<typeof useReviewDrawer>

const checksPassed = (pr: PullRequest) => pr.checks.filter((check) => check.status === "pass").length

/** The ⅓ read-only review panel: context strip plus draft findings the operator adds to the review or dismisses. */
export function ReviewDrawer({ pr, drawer, onPromote }: { pr: PullRequest; drawer: ReviewDrawerState; onPromote?: (summary: string) => void }) {
  const { context, send } = drawer
  const undecided = undecidedDrafts(context)
  return (
    <aside aria-label={`Review #${pr.number}`} className="flex w-1/3 min-w-[280px] flex-none flex-col border-l border-hairline bg-panel">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-text-bright">Review #{pr.number}</h2>
        <Pill tone="blue" dot={false}>Read-only</Pill>
        <div className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          disabled={!onPromote}
          onClick={() => {
            send({ type: "PROMOTE" })
            onPromote?.(promotionSummary(pr, context))
          }}
        >
          Promote to session
        </Button>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close review drawer" onClick={() => send({ type: "CLOSE" })}>
          <X size={14} aria-hidden />
        </Button>
      </div>
      <p className="border-b border-hairline px-3 py-2 font-mono text-[11px] text-muted-foreground">
        diff {pr.changedFiles} files · {pr.reviewThreads.length} threads · checks {checksPassed(pr)}/{pr.checks.length}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {undecided.length > 1 && (
          <Button variant="secondary" size="sm" className="self-end" onClick={() => send({ type: "ADD_ALL" })}>
            Add all to review
          </Button>
        )}
        {context.run === "running" && <InlineStatus variant="loading">Reviewing the diff…</InlineStatus>}
        {context.run === "failed" && <InlineError message={context.error ?? "The review failed"} onRetry={drawer.retry} />}
        {context.run !== "running" && context.run !== "failed" && context.drafts.length === 0 && <EmptyState title="No findings yet" description="Draft findings from the review agent appear here." />}
        {context.drafts.map((draft) => (
          <DraftCard key={draft.id} draft={draft} added={context.added.includes(draft.id)} dismissed={context.dismissed.includes(draft.id)} send={send} />
        ))}
      </div>
    </aside>
  )
}

function DraftCard({ draft, added, dismissed, send }: { draft: ReviewFindingDraft; added: boolean; dismissed: boolean; send: ReviewDrawerState["send"] }) {
  if (dismissed) return null
  return (
    <div data-testid="review-draft" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <Badge tone={draft.severity === "issue" ? "red" : "neutral"} size="sm">{draft.severity === "issue" ? "Issue" : "Nit"}</Badge>
        <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{draft.path}:{draft.line}</code>
      </div>
      <p className="text-[13px] text-text-body">{draft.body}</p>
      {added ? (
        <Badge tone="green" size="sm" className="self-start">Added to review</Badge>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => send({ type: "ADD", id: draft.id })}>Add to review</Button>
          <Button variant="ghost" size="sm" onClick={() => send({ type: "DISMISS", id: draft.id })}>Dismiss</Button>
        </div>
      )}
    </div>
  )
}
