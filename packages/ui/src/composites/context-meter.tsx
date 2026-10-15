import type { ContextBreakdown, ContextPhase } from "@jingler/core"
import { LoaderCircle } from "lucide-react"
import type { ReactNode } from "react"
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "../components/beui/popover-morph.js"
import { Button } from "../components/button.js"
import { Spin } from "../components/spin.js"
import { cn } from "../lib/cn.js"

/** "42.6k" / "980" — compact token count. */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n)

export interface ContextMeterProps {
  /** Latest working-set reading, in tokens. */
  tokens: number
  /** Estimated category allocation, scaled to the provider-reported total. */
  breakdown?: ContextBreakdown | null
  /** Where compaction fires: `min(budget, window × safety)`. Null = unknown window. */
  triggerAt: number | null
  /**
   * What the context manager will ACTUALLY do with this session.
   *
   * The meter must not re-derive this from `tokens / triggerAt`. `triggerAt` is
   * computed the moment the model's window is known, but compaction additionally
   * requires auto-compaction to be enabled AND the harness to report usage — so
   * `contextPhase` returns `"unknown"` in cases where the ratio is well past 1.
   */
  phase?: ContextPhase
  /** A summary is being built right now, on a background fiber. */
  preparing?: boolean
  /** A digest is built and the next turn will reseed. */
  digestReady?: boolean
  /** Consecutive digest failures hit the ceiling; nothing more will be tried. The ONLY state drawn red. */
  stalled?: boolean
  /**
   * A digest is ready but is being deliberately HELD because the session is
   * mid-task. Distinct from `digestReady` and it must outrank it: a held
   * session would otherwise promise "compacts next turn" for several turns.
   */
  held?: boolean
  /** One line naming what is in flight, shown in the popover. */
  heldReason?: string | null
  /** Compact this session now, ahead of the budget. Offered inside the popover. */
  onCompactNow?: () => void
  /**
   * What the ring surrounds — the composer's send button. Without it the ring
   * stands alone with its percentage and a token readout beside it.
   */
  children?: ReactNode
  className?: string
}

type ContextStatus = Pick<
  ContextMeterProps,
  "phase" | "preparing" | "digestReady" | "stalled" | "held" | "heldReason" | "onCompactNow"
>

const willCompact = (s: ContextStatus): boolean => s.phase === "prepare" || s.phase === "swap"

/** Four states, in the order they actually occur; an in-flight summary outranks everything. */
function contextLabel(s: ContextStatus): string {
  if (s.preparing) return "compacting…"
  if (s.held) return "compaction held"
  if (s.digestReady) return "compacts next turn"
  if (s.stalled) return "compaction failed"
  if (willCompact(s)) return "compacting soon"
  return "context"
}

function contextHint(s: ContextStatus): string {
  if (s.preparing) return " · summarising in the background"
  if (s.held) return ` · a summary is ready but held: ${s.heldReason ?? "the session is mid-task"}`
  if (s.digestReady) return " · the next turn starts from a summary"
  if (s.stalled) return " · automatic compaction gave up after repeated failures; click to try again"
  if (s.phase === "unknown") return " · automatic compaction is off for this session"
  if (s.onCompactNow) return " · open for details and compact now"
  return ""
}

const contextTitle = (tokens: number, target: number | null, status: string): string =>
  target === null
    ? `${tokens.toLocaleString()} context tokens · compaction target unavailable`
    : `${tokens.toLocaleString()} of ~${target.toLocaleString()} tokens before Jingler compacts this session${status}`

const RING_RADIUS = 17
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * The usage arc. Neutral at every fill level — crossing the trigger is the
 * system working, and an alarm colour would train the user to intervene in
 * something that handles itself. Red is reserved for `stalled`: nothing more
 * will be tried, so there is something to do.
 */
function ContextArc({ ratio, hasTarget, stalled, preparing }: {
  ratio: number
  hasTarget: boolean
  stalled: boolean
  preparing: boolean
}) {
  const circle = { cx: 18, cy: 18, r: RING_RADIUS, fill: "none", strokeWidth: 2 }
  return (
    <svg aria-hidden="true" viewBox="0 0 36 36" className="size-full -rotate-90">
      <circle {...circle} className="stroke-fg/10" />
      {hasTarget && (
        <circle
          {...circle}
          data-testid="context-ring-arc"
          strokeLinecap="round"
          strokeDasharray={`${RING_CIRCUMFERENCE * Math.max(ratio, 0.02)} ${RING_CIRCUMFERENCE}`}
          className={cn(
            "transition-[stroke-dasharray]",
            stalled ? "stroke-state-failed" : "stroke-muted-foreground",
            // Only while a summary is genuinely in flight — a pulse that never
            // stops is noise, and one that stops says "done".
            preparing && "animate-pulse"
          )}
        />
      )}
    </svg>
  )
}

/**
 * How full the model's working set is, drawn as a ring around the send button,
 * measured against the point at which Jingler will compact it — NOT against the
 * model's hard ceiling. A 1M-window model shows a full ring at the budget,
 * because that is where quality starts to go; the hard window is deliberately
 * not drawn. An unknown window shows the reported total but no arc.
 *
 * The ring is the click target for the detail popover; the surrounded button
 * keeps its own action.
 */
export function ContextMeter({
  tokens,
  breakdown = null,
  triggerAt,
  phase = "unknown",
  preparing = false,
  digestReady = false,
  stalled = false,
  held = false,
  heldReason = null,
  onCompactNow,
  children,
  className
}: ContextMeterProps) {
  if (tokens <= 0) return <>{children}</>

  const target = triggerAt !== null && triggerAt > 0 ? triggerAt : null
  const ratio = target === null ? 0 : Math.min(1, tokens / target)
  const pct = Math.round(ratio * 100)
  const status: ContextStatus = { phase, preparing, digestReady, stalled, held, heldReason, onCompactNow }
  const label = contextLabel(status)
  const title = contextTitle(tokens, target, contextHint(status))
  const alone = children === undefined

  return (
    <MorphPopover className={cn("items-center", className)}>
      <span className="relative grid size-9 flex-none place-items-center">
        <MorphPopoverTrigger>
          <Button
            variant="ghost"
            size="icon"
            pressScale={1}
            aria-label={target === null ? `Context usage ${fmtTokens(tokens)}` : `Context usage ${pct}%`}
            title={title}
            className="absolute inset-0 size-full rounded-full p-0 hover:bg-transparent"
          >
            <ContextArc ratio={ratio} hasTarget={target !== null} stalled={stalled} preparing={preparing} />
          </Button>
        </MorphPopoverTrigger>
        <span className="relative z-10 flex items-center justify-center">
          {alone ? (
            <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
              {target === null ? "" : `${pct}%`}
            </span>
          ) : (
            children
          )}
        </span>
      </span>
      {alone && (
        <span className="ml-1 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {fmtTokens(tokens)} <span className="text-dim">{label}</span>
        </span>
      )}
      <MorphPopoverContent side="top" align="end" radius={12} className="w-64 p-3">
        <ContextDetails
          tokens={tokens}
          breakdown={breakdown}
          target={target}
          title={title}
          label={label}
          preparing={preparing}
          canCompact={onCompactNow !== undefined}
          busy={preparing || digestReady}
          onCompactNow={onCompactNow}
        />
      </MorphPopoverContent>
    </MorphPopover>
  )
}

function CategoryRows({ breakdown }: { breakdown: ContextBreakdown | null }) {
  if (breakdown === null) return null
  const categories: ReadonlyArray<readonly [string, number]> = [
    ["System prompt", breakdown.systemPrompt],
    ["Tool schemas & calls", breakdown.tools],
    ["Skills", breakdown.skills],
    ["MCPs", breakdown.mcps],
    ["Messages", breakdown.messages]
  ]
  return (
    <div className="space-y-1 border-t border-hairline pt-2">
      {categories.map(([name, value]) => (
        <div key={name} className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{name}</span>
          <span className="font-mono tabular-nums text-text-bright">{fmtTokens(value)}</span>
        </div>
      ))}
    </div>
  )
}

function ContextDetails({ tokens, breakdown, target, title, label, preparing, canCompact, busy, onCompactNow }: {
  tokens: number
  breakdown: ContextBreakdown | null
  target: number | null
  title: string
  label: string
  preparing: boolean
  canCompact: boolean
  /** A compaction is already under way, so starting another would do nothing. */
  busy: boolean
  onCompactNow: (() => void) | undefined
}) {
  return (
    <div data-testid="context-breakdown" className="space-y-2 font-sans text-[11px]">
      <div>
        <div className="font-medium text-text-bright">Context usage</div>
        <div className="mt-0.5 text-dim">
          {breakdown === null
            ? "This harness reports a total, but no category breakdown."
            : "Category estimates scaled to the provider-reported total"}
        </div>
      </div>
      <CategoryRows breakdown={breakdown} />
      <div className="flex items-center justify-between border-t border-hairline pt-2">
        <span className="text-muted-foreground">Total</span>
        <span className="font-mono tabular-nums text-text-bright">{tokens.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Compaction target</span>
        <span className="font-mono tabular-nums text-text-bright">{target?.toLocaleString() ?? "Unknown"}</span>
      </div>
      <div className="text-dim">{target === null ? "The model's context window is unavailable." : title}</div>
      <div className="flex items-center justify-between gap-2 border-t border-hairline pt-2">
        <span data-testid="context-status" className="flex items-center gap-1.5 text-muted-foreground">
          {preparing && <Spin><LoaderCircle size={12} aria-hidden="true" /></Spin>}
          {label}
        </span>
        {canCompact && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={onCompactNow}>
            Compact now
          </Button>
        )}
      </div>
    </div>
  )
}
