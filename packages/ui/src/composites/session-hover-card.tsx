import type { Session, SessionActivity, SessionPrStatus } from "@jingler/core"
import { activeCheckoutOf, activityLabel, checkoutsOf, displayStatusOf, hasNoRepo, reposLabelOf, UNTITLED_SESSION } from "@jingler/core"
import { GitBranch } from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { StatusDot } from "../components/status-dot.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { DiffStat } from "../components/diff-stat.js"
import { PrStatusGlyph } from "./pr-glyph.js"
import { PR_STATE_LABEL, type PrStackLayer } from "./pr-stack-rail.js"
import { displayStatusLabel, displayStatusTone, statusTextClass } from "../tokens.js"

/** One row of the hover card's PR stack list: a layer's number and state word. */
export interface PrStackRow {
  readonly number: number
  readonly stateWord: string
}

/**
 * The hover card's stack rows, in the caller's order (bottom of the stack
 * first, matching `Session.prs`/`PrStackLayer`). A layer whose state hasn't
 * loaded yet (the live poll is still in flight) gets the word "—" rather than
 * guessing a state it doesn't have.
 */
export const prStackRowsOf = (layers: ReadonlyArray<PrStackLayer> | undefined): ReadonlyArray<PrStackRow> =>
  (layers ?? []).map((layer) => ({
    number: layer.number,
    stateWord: layer.state ? PR_STATE_LABEL[layer.state] : "—"
  }))

/**
 * What a session looks like when the sidebar is a 52px rail.
 *
 * The rail can show two facts — that a session exists, and roughly how it's
 * doing. This card is where the other six live, so collapsing the sidebar costs
 * reach rather than information. It deliberately carries the SAME facts as
 * `SessionRow` (title, repo/branch, status, diff, PR, age) and no more: a card
 * that showed things the expanded sidebar doesn't would make the two states
 * disagree about what a session is.
 *
 * The one addition is the PR STACK list: a stacked session's rail glyph only
 * has room for the worst layer and a count, so the card is where "which PRs,
 * in what order, in what state" actually lives.
 *
 * Read-only by design. Archive and delete stay on the row, because a card you
 * must chase with the pointer to click is a card you will misclick.
 */
export function SessionHoverCard({
  session,
  activity,
  interrupted,
  prState,
  stack
}: {
  session: Session
  /** What the agent is doing right now; absent falls back to the persisted status. */
  activity?: SessionActivity
  interrupted?: boolean
  /** Live PR state; `null`/absent renders no PR line at all. */
  prState?: SessionPrStatus | null
  /** This session's PR stack, bottom layer first. More than one layer renders a stack list instead of the single PR line. */
  stack?: ReadonlyArray<PrStackLayer>
}) {
  const display = displayStatusOf(activity, session.status, interrupted)
  // The detail line ("Running pnpm test -- auth") when there IS live activity;
  // the five-word rollup otherwise. Never both — they'd say the same thing twice.
  const detail = activity ? activityLabel(activity) : displayStatusLabel[display]
  const { added, removed } = session.diff
  const hasDiff = added > 0 || removed > 0
  const stackRows = prStackRowsOf(stack)
  const isStacked = stackRows.length > 1

  return (
    <div className="flex w-[240px] flex-col gap-1.5">
      {/* The harness leads the card because it leads the rail cell — the icon
          you hovered is the first thing the card confirms. */}
      <span className="flex min-w-0 items-center gap-1.5">
        <ProviderIcon
          providerId={session.providerId ?? undefined}
          size={13}
          className="flex-none"
        />
        <span className="truncate text-[12.5px] font-semibold leading-snug text-text-bright">
          {session.title || UNTITLED_SESSION}
        </span>
      </span>

      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-dim">
        <GitBranch size={11} className="flex-none text-cyan" />
        <span className="truncate">
          {hasNoRepo(activeCheckoutOf(session)) || checkoutsOf(session).length > 1 ? reposLabelOf(session) : `${session.repo} · ${session.branch}`}
        </span>
      </span>

      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-[11px]",
          statusTextClass[displayStatusTone[display]]
        )}
      >
        <StatusDot status={displayStatusTone[display]} size={7} />
        <span className="truncate">{detail}</span>
      </span>

      {/* The footer only exists when it has something to say — an untouched
          session with no PR would otherwise get an empty grey strip. */}
      {(hasDiff || session.prNumber !== null || isStacked) && (
        <div className="flex flex-col gap-1.5 border-t border-hairline pt-1.5">
          {hasDiff && <DiffStat added={added} removed={removed} />}
          {isStacked ? (
            <div className="flex flex-col gap-1" data-testid="hover-card-pr-stack">
              {stackRows.map((row, index) => {
                const layer = stack?.[index]
                return (
                  <span
                    key={row.number}
                    data-testid={`hover-card-pr-stack-row-${row.number}`}
                    className="flex items-center gap-1.5 font-mono text-[10px] text-dim"
                  >
                    {layer?.state ? (
                      <PrStatusGlyph pr={{ state: layer.state, checks: layer.checks ?? null }} size={11} />
                    ) : (
                      <span aria-hidden className="size-[11px] flex-none" />
                    )}
                    <span>#{row.number}</span>
                    <span className="text-muted-foreground">{row.stateWord}</span>
                  </span>
                )
              })}
            </div>
          ) : (
            session.prNumber !== null && (
              <span className="flex items-center gap-1 font-mono text-[10px] text-dim">
                <PrStatusGlyph pr={prState ?? null} size={12} />#{session.prNumber}
              </span>
            )
          )}
        </div>
      )}

      <span className="font-mono text-[10px] text-muted-foreground">
        {relativeTime(session.updatedAt)}
      </span>
    </div>
  )
}
