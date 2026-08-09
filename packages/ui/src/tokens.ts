/**
 * Token helpers for JS-land. Colors themselves live in `globals.css` (One Dark)
 * and are consumed via Tailwind utilities (bg-panel, text-blue, …). These maps
 * translate domain enums to the right accent utility class.
 */
import type { ReviewSeverity, SessionDisplayStatus, SessionStatus } from "@jingler/core"

/** Semantic accent per session/agent status → Tailwind text color utility. */
export const statusTextClass: Record<SessionStatus, string> = {
  thinking: "text-yellow",
  running: "text-blue",
  "needs-input": "text-blue",
  idle: "text-line-strong",
  done: "text-green"
}

/** Accent per status → Tailwind background color utility (for dots). */
export const statusDotClass: Record<SessionStatus, string> = {
  thinking: "bg-yellow",
  running: "bg-blue",
  "needs-input": "bg-blue",
  idle: "bg-line-strong",
  done: "bg-green"
}

/**
 * The five words a session may report in the sidebar — its row label, and its
 * group header when grouping by status.
 *
 * This is the ONLY place the sidebar names a state. It replaced a lowercase
 * `statusLabel` ("running", "idle") that competed with a separate, capitalised
 * `activityLabel` ("Running npm test") on the same line of the same row, and a
 * third set of group headers that called the same state "Working". Three
 * vocabularies for one concept, and the row could show any of them depending on
 * whether an activity happened to be in flight.
 *
 * Title Case because these are labels, not prose, and they sit beside a
 * capitalised branch name.
 */
export const displayStatusLabel: Record<SessionDisplayStatus, string> = {
  thinking: "Thinking",
  running: "Running",
  "needs-input": "Needs Input",
  monitoring: "Monitoring",
  idle: "Idle"
}

/**
 * The `SessionStatus` a display status borrows its colour and pulse from.
 *
 * Monitoring has no colour of its own, deliberately: it IS a kind of running, and
 * a fifth dot colour would claim it's a different KIND of thing rather than a
 * different flavour of the same one. The word carries that; the colour shouldn't
 * have to. Keeping this fold in one place is also what stops the row and the
 * group header drifting apart on it.
 */
export const displayStatusTone: Record<SessionDisplayStatus, SessionStatus> = {
  thinking: "thinking",
  running: "running",
  "needs-input": "needs-input",
  monitoring: "running",
  idle: "idle"
}

/** Whether a status should glow/pulse its dot. */
export const statusPulses = (s: SessionStatus): boolean =>
  s === "thinking" || s === "running"

/**
 * Semantic accent per adversarial-review severity.
 *
 * The colour IS the triage: findings render worst-first, and severity is what
 * the reviewer is asked to tag honestly so the reader can rank at a glance.
 * Ramped along the palette's own temperature — red (act now) → yellow → blue
 * (noted) → dim (whenever) — so a card's weight reads before its words do.
 *
 * `rail` is a left border, deliberately not a filled badge: at four severities
 * across a scrolling list, four filled chips shout equally and the ranking
 * disappears. A 2px rail carries the same information at a fraction of the ink.
 */
export const severityAccent: Record<
  ReviewSeverity,
  { rail: string; dot: string; text: string }
> = {
  critical: { rail: "border-l-red/70", dot: "bg-red", text: "text-red" },
  major: { rail: "border-l-yellow/70", dot: "bg-yellow", text: "text-yellow" },
  minor: { rail: "border-l-blue/55", dot: "bg-blue", text: "text-blue" },
  nit: { rail: "border-l-line-strong", dot: "bg-line-strong", text: "text-muted-foreground" }
}
