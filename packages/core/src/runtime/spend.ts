import { Schema } from "effect"
import type { UsageFact } from "./usage-facts.js"

/** Tokens and estimated cost for an API-priced connection (no subscription windows). */
export const SpendTotals = Schema.Struct({
  tokens: Schema.Number,
  costUsd: Schema.Number
})
export type SpendTotals = Schema.Schema.Type<typeof SpendTotals>

export const ProviderSpend = Schema.Struct({
  /** The most recently active session, or null before any turn. */
  lastSession: Schema.NullOr(SpendTotals),
  today: SpendTotals,
  month: SpendTotals
})
export type ProviderSpend = Schema.Schema.Type<typeof ProviderSpend>

const zero = (): { tokens: number; costUsd: number } => ({ tokens: 0, costUsd: 0 })
const add = (total: { tokens: number; costUsd: number }, tokens: number, costUsd: number): void => {
  total.tokens += tokens
  total.costUsd += costUsd
}

/**
 * Parent facts carry the session's running total (the CLI's `total_cost_usd` is
 * cumulative across `--resume`, and pi reports session stats), so a turn's spend
 * is the step from the previous fact. A drop means the counter restarted.
 * The native Claude runtime reports tokens per turn already.
 */
const step = (value: number, previous: number): number => (value >= previous ? value - previous : value)

interface SpendTurn {
  readonly sessionId: string
  readonly at: number
  readonly tokens: number
  readonly costUsd: number
}

const turnsFromFacts = (facts: ReadonlyArray<UsageFact>): ReadonlyArray<SpendTurn> => {
  const turns: SpendTurn[] = []
  const parents = new Map<string, Array<UsageFact>>()
  for (const fact of facts) {
    if (fact.kind === "child") {
      if (fact.costUsd !== null) {
        turns.push({ sessionId: fact.sessionId, at: Date.parse(fact.endedAt), tokens: fact.totalTokens ?? 0, costUsd: fact.costUsd })
      }
      continue
    }
    const key = JSON.stringify([fact.sessionId, fact.runtimeId])
    parents.set(key, [...(parents.get(key) ?? []), fact])
  }
  for (const session of parents.values()) {
    let previousCost = 0
    let previousTokens = 0
    for (const fact of [...session].sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))) {
      const cumulativeTokens = fact.runtimeId === "pi"
      const tokens = fact.totalTokens ?? 0
      const turnTokens = cumulativeTokens ? step(tokens, previousTokens) : tokens
      if (cumulativeTokens) previousTokens = tokens
      let turnCost = 0
      if (fact.costUsd !== null) {
        turnCost = step(fact.costUsd, previousCost)
        previousCost = fact.costUsd
      }
      turns.push({ sessionId: fact.sessionId, at: Date.parse(fact.endedAt), tokens: turnTokens, costUsd: turnCost })
    }
  }
  return turns
}

/** Spend per last session / today / this month (local calendar) from per-turn usage facts. */
export const spendFromFacts = (
  facts: ReadonlyArray<UsageFact>,
  now: Date = new Date()
): ProviderSpend => {
  const turns = turnsFromFacts(facts)
  const spend = { lastSession: null as { tokens: number; costUsd: number } | null, today: zero(), month: zero() }
  const latest = turns.reduce<SpendTurn | null>((best, turn) => (best === null || turn.at > best.at ? turn : best), null)
  for (const turn of turns) {
    const at = new Date(turn.at)
    if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth()) {
      add(spend.month, turn.tokens, turn.costUsd)
      if (at.getDate() === now.getDate()) add(spend.today, turn.tokens, turn.costUsd)
    }
    if (latest !== null && turn.sessionId === latest.sessionId) add(spend.lastSession ??= zero(), turn.tokens, turn.costUsd)
  }
  return spend
}
