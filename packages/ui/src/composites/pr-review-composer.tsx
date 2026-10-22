import * as React from "react"
import type { ReviewSubmitKind } from "@jingler/core"
import { AsyncButton } from "../components/async-button.js"
import { Callout } from "../components/callout.js"
import { Toggle } from "../components/toggle.js"
import { composeReviewBody, type ReviewFindingDraft } from "./review-drawer-machine.js"

/**
 * The sticky bottom review composer for the Pull Request tab — a comment draft,
 * a "route to agent" switch, and the three GitHub review actions (each with async
 * feedback while it posts).
 */
export function PrReviewComposer({
  connected,
  selfAuthored = false,
  commentOnly = false,
  ariaLabel,
  pending = [],
  onSubmitted,
  onSubmit
}: {
  connected: boolean
  /**
   * The viewer authored this PR. GitHub forbids approving / requesting changes on
   * your own pull request, so those actions are disabled (Comment stays allowed).
   */
  selfAuthored?: boolean
  /** Global PR comments do not expose review verdicts or agent routing. */
  commentOnly?: boolean
  /** Accessible name for the draft textarea. */
  ariaLabel?: string
  /** Findings added from the review drawer; sent with the review body, nothing posts until submit. */
  pending?: ReadonlyArray<ReviewFindingDraft>
  onSubmitted?: () => void
  onSubmit: (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => Promise<void> | void
}) {
  const [body, setBody] = React.useState("")
  const [routeToAgent, setRouteToAgent] = React.useState(!commentOnly)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (kind: ReviewSubmitKind) => {
    if (!connected) return
    setError(null)
    const submitted = body
    try {
      await onSubmit({ body: composeReviewBody(submitted.trim(), pending), kind, routeToAgent })
      onSubmitted?.()
      // Text typed while the request was pending is unsent; keep it.
      setBody((current) => (current === submitted ? "" : current))
    } catch (e) {
      // Surface the real reason (e.g. "Can not approve your own pull request")
      // instead of the button's silent shake.
      setError(e instanceof Error ? e.message : "Failed to submit review.")
      throw e // let the AsyncButton show its error state too
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={commentOnly ? "Leave a comment…" : "Leave a review comment…"}
        aria-label={ariaLabel}
        rows={2}
        className="w-full resize-none bg-transparent px-[14px] py-[11px] text-[13.5px] text-text-body outline-none placeholder:text-dim"
      />
      {pending.length > 0 && (
        <ul data-testid="pr-pending-comments" className="flex flex-col gap-1 px-[14px] pb-[11px] text-[12px] text-text-body">
          {pending.map((d) => (
            <li key={d.id}><code className="font-mono text-muted-foreground">{d.path}:{d.line}</code> — {d.body}</li>
          ))}
        </ul>
      )}
      {!connected && (
        <div className="px-[14px] pb-[11px]">
          <Callout tone="blue">Connect GitHub to post reviews.</Callout>
        </div>
      )}
      {error && (
        <div className="px-[14px] pb-[11px]">
          <Callout tone="red">{error}</Callout>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-2 border-t border-hairline px-[14px] py-[11px]">
        {!commentOnly && (
          <label className="flex items-center gap-2 text-[11.5px] text-text">
            <Toggle checked={routeToAgent} onCheckedChange={setRouteToAgent} />
            Also send to agent
          </label>
        )}
        <div className="flex-1" />
        <AsyncButton
          variant="secondary"
          disabled={!connected || (commentOnly && body.trim().length === 0 && pending.length === 0)}
          pendingLabel="Posting…"
          successLabel="Commented"
          onClick={() => submit("comment")}
        >
          Comment
        </AsyncButton>
        {/* GitHub forbids self-approval, so on your own PR these are disabled; Comment stays. */}
        {!commentOnly && (
          <>
            <AsyncButton
              variant="danger"
              disabled={!connected || selfAuthored}
              pendingLabel="Requesting…"
              successLabel="Requested"
              onClick={() => submit("request-changes")}
            >
              Request changes
            </AsyncButton>
            <AsyncButton
              variant="primary"
              disabled={!connected || selfAuthored}
              pendingLabel="Approving…"
              successLabel="Approved"
              onClick={() => submit("approve")}
            >
              Approve
            </AsyncButton>
          </>
        )}
      </div>
    </div>
  )
}
