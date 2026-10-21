import { Button } from "../components/button.js"
import { Card } from "../components/card.js"
import { Skeleton } from "../components/loading.js"
import { StatusRow } from "../components/status-row.js"

/** Home › a run blocked on the operator. A stale card (no longer pending) turns neutral and only dismisses. */
export function NeedsYouCard({
  title,
  text,
  stale = false,
  onAllow,
  onAnswer,
  onDismiss
}: {
  readonly title: string
  readonly text: string
  readonly stale?: boolean
  readonly onAllow?: () => void
  readonly onAnswer: () => void
  readonly onDismiss: () => void
}) {
  return (
    <Card className="px-4 py-3" >
      <div className="text-[11px] text-dim">{title}</div>
      {stale ? (
        <StatusRow className="mt-1">
          No longer waiting · <Button variant="ghost" size="sm" onClick={onDismiss} className="inline h-auto px-0 py-0 hover:bg-transparent hover:underline">Dismiss</Button>
        </StatusRow>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-text-bright">{text}</p>
          <div className="mt-2 flex items-center gap-2">
            {onAllow ? <Button size="sm" onClick={onAllow}>Allow</Button> : null}
            <Button size="sm" variant="secondary" onClick={onAnswer}>Answer</Button>
          </div>
        </>
      )}
    </Card>
  )
}

/** Home › one session that is working right now. */
export function RunningRow({ title, activity, onOpen }: { readonly title: string; readonly activity: string; readonly onOpen: () => void }) {
  return (
    <Button variant="ghost" onClick={onOpen} className="w-full justify-between">
      <span className="truncate">{title}</span>
      <span className="truncate text-[12px] text-dim">{activity}</span>
    </Button>
  )
}

export type ImportCardState = "detecting" | "found" | "failed"

/** Home › dismissible MCP import card: scanning skeleton, found counts, or a retryable failure. */
export function ImportCard({
  state,
  count = 0,
  onReview,
  onDismiss,
  onRetry
}: {
  readonly state: ImportCardState
  readonly count?: number
  readonly onReview: () => void
  readonly onDismiss: () => void
  readonly onRetry: () => void
}) {
  if (state === "detecting") {
    return (
      <Card className="px-4 py-3">
        <Skeleton className="h-4 w-48" />
      </Card>
    )
  }
  if (state === "failed") {
    return (
      <Card className="px-4 py-3">
        <StatusRow failed>
          Couldn't scan Claude Code · <Button variant="ghost" size="sm" onClick={onRetry} className="inline h-auto px-0 py-0 hover:bg-transparent hover:underline">Retry</Button>
        </StatusRow>
      </Card>
    )
  }
  return (
    <Card className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1 text-[13px] text-text-bright">
        Found {count} MCP server{count === 1 ? "" : "s"} in Claude Code, Codex and OpenCode
      </span>
      <Button size="sm" onClick={onReview}>Review</Button>
      <Button size="sm" variant="ghost" onClick={onDismiss}>Not now</Button>
    </Card>
  )
}
