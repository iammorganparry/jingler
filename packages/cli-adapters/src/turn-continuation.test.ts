import { describe, expect, it } from "vitest"
import { type TurnContinuationState, turnContinuation } from "./turn-continuation.js"

/**
 * The policy is a table, so it is tested as one — every combination, not the ones
 * that happen to occur. There are only 36, and the whole reason this was pulled out
 * of the SDK loop is that "what would the adapter do here?" used to be unanswerable
 * without a fake harness and a timer.
 */

const STEERED = [false, true] as const
const UNREAD = [false, true] as const
const SUBAGENTS = [0, 1, 2] as const
const TERMINAL = ["done", "failed", null] as const

/** The expectation, stated independently of the implementation's branch order. */
const expected = (s: TurnContinuationState): ReturnType<typeof turnContinuation> => {
  if (s.terminalKind === "failed") return { kind: "close", because: "failed" }
  if (s.steered || s.unread) return { kind: "continue", because: "steer-pending" }
  if (s.liveSubagents > 0) return { kind: "continue", because: "subagent-work" }
  return { kind: "close", because: "turn-finished" }
}

const rows: ReadonlyArray<TurnContinuationState> = STEERED.flatMap((steered) =>
  UNREAD.flatMap((unread) =>
    SUBAGENTS.flatMap((liveSubagents) =>
      TERMINAL.map((terminalKind) => ({ steered, unread, liveSubagents, terminalKind }))
    )
  )
)

const label = (s: TurnContinuationState) =>
  `steered=${s.steered} unread=${s.unread} subagents=${s.liveSubagents} terminal=${s.terminalKind}`

describe("turnContinuation — the whole table", () => {
  it("enumerates every combination of the four inputs", () => {
    expect(rows).toHaveLength(2 * 2 * 3 * 3)
  })

  it.each(rows.map((s) => [label(s), s] as const))("%s", (_name, state) => {
    expect(turnContinuation(state)).toStrictEqual(expected(state))
  })

  it("reaches all four verdicts across the table", () => {
    const seen = new Set(rows.map((s) => `${turnContinuation(s).kind}/${turnContinuation(s).because}`))
    expect([...seen].sort()).toStrictEqual([
      "close/failed",
      "close/turn-finished",
      "continue/steer-pending",
      "continue/subagent-work"
    ])
  })
})

/**
 * The three regressions this module replaces. Each was a real defect in the inline
 * version, and each is invisible in the table above unless you know which row to
 * look at — so they are named.
 */
describe("turnContinuation — the rules that bit", () => {
  it("holds the turn open for sub-agents that are still working", () => {
    // THE BUG. The main agent's `result` lands while its backgrounded Tasks run on,
    // and closing the channel there ends the one query every sub-agent lives in —
    // so `abort()` reaped all of them the moment the operator talked to the chat.
    expect(
      turnContinuation({ steered: false, unread: false, liveSubagents: 3, terminalKind: "done" })
    ).toStrictEqual({ kind: "continue", because: "subagent-work" })
  })

  it("never drops a pending steer for want of sub-agents", () => {
    // The inline version was `takeSteered() || hasUnread()`. `takeSteered()` is a
    // CONSUMING read, so any reordering that put a cheaper test first would
    // short-circuit past it and lose the operator's message outright.
    expect(
      turnContinuation({ steered: true, unread: false, liveSubagents: 0, terminalKind: "done" })
    ).toStrictEqual({ kind: "continue", because: "steer-pending" })
  })

  it("prefers the steer over sub-agent work when both are true", () => {
    // Not arbitrary: the steer needs the SHORT timer. Reporting `subagent-work`
    // here would arm SUBAGENT_LINGER_CAP for a continuation due in milliseconds,
    // leaving the turn visibly running for ten minutes after it finished.
    expect(
      turnContinuation({ steered: true, unread: true, liveSubagents: 2, terminalKind: null })
    ).toStrictEqual({ kind: "continue", because: "steer-pending" })
  })

  it("never withholds a Failed, whatever else is outstanding", () => {
    // The run IS over. Holding the channel open here means the query never ends
    // and the turn streams forever with nothing to settle it.
    for (const state of [
      { steered: true, unread: true, liveSubagents: 2, terminalKind: "failed" as const },
      { steered: false, unread: false, liveSubagents: 1, terminalKind: "failed" as const }
    ]) {
      expect(turnContinuation(state)).toStrictEqual({ kind: "close", because: "failed" })
    }
  })

  it("closes once nothing is left — no steer, no sub-agents", () => {
    expect(
      turnContinuation({ steered: false, unread: false, liveSubagents: 0, terminalKind: "done" })
    ).toStrictEqual({ kind: "close", because: "turn-finished" })
  })

  it("closes a held turn the moment its last sub-agent bookends", () => {
    // The foot-of-loop call, which passes `terminalKind: null` because the terminal
    // event was withheld messages ago. Going from 1 to 0 is what returns the input
    // generator and lets the withheld `Done` finally be emitted.
    const held = { steered: false, unread: false, terminalKind: null } as const
    expect(turnContinuation({ ...held, liveSubagents: 1 })).toStrictEqual({
      kind: "continue",
      because: "subagent-work"
    })
    expect(turnContinuation({ ...held, liveSubagents: 0 })).toStrictEqual({
      kind: "close",
      because: "turn-finished"
    })
  })

  it("keeps a held turn open for a push that arrived while it was held", () => {
    // A message sent DURING sub-agent work: the sub-agents finish, but the push is
    // still unread, so the channel must stay open for the turn it will open.
    expect(
      turnContinuation({ steered: false, unread: true, liveSubagents: 0, terminalKind: null })
    ).toStrictEqual({ kind: "continue", because: "steer-pending" })
  })
})
