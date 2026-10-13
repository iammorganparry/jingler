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

const turnAt = (fact: UsageFact, tokens: number, costUsd: number): SpendTurn => ({
  sessionId: fact.sessionId,
  at: Date.parse(fact.endedAt),
  tokens,
  costUsd
})

const sessionTurns = (session: ReadonlyArray<UsageFact>): ReadonlyArray<SpendTurn> => {
  let previousCost = 0
  let previousTokens = 0
  return [...session]
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
    .map((fact) => {
      const tokens = fact.totalTokens ?? 0
      const turnTokens = fact.runtimeId === "pi" ? step(tokens, previousTokens) : tokens
      previousTokens = tokens
      const turnCost = fact.costUsd === null ? 0 : step(fact.costUsd, previousCost)
      if (fact.costUsd !== null) previousCost = fact.costUsd
      return turnAt(fact, turnTokens, turnCost)
    })
}

const turnsFromFacts = (facts: ReadonlyArray<UsageFact>): ReadonlyArray<SpendTurn> => {
  const children = facts.filter((fact) => fact.kind === "child" && fact.costUsd !== null)
  const parents = new Map<string, Array<UsageFact>>()
  for (const fact of facts.filter((candidate) => candidate.kind === "parent")) {
    const key = JSON.stringify([fact.sessionId, fact.runtimeId])
    parents.set(key, [...(parents.get(key) ?? []), fact])
  }
  return [
    ...children.map((fact) => turnAt(fact, fact.totalTokens ?? 0, fact.costUsd ?? 0)),
    ...[...parents.values()].flatMap(sessionTurns)
  ]
}

/** Spend per last session / today / this month (local calendar) from per-turn usage facts. */
export const spendFromFacts = (
  facts: ReadonlyArray<UsageFact>,
  now: Date = new Date()
): ProviderSpend => {
  const turns = turnsFromFacts(facts)
  const spend = { lastSession: zero(), today: zero(), month: zero() }
  const latest = turns.reduce<SpendTurn | null>((best, turn) => (best === null || turn.at > best.at ? turn : best), null)
  for (const turn of turns) {
    const at = new Date(turn.at)
    if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth()) {
      add(spend.month, turn.tokens, turn.costUsd)
      if (at.getDate() === now.getDate()) add(spend.today, turn.tokens, turn.costUsd)
    }
    if (turn.sessionId === latest?.sessionId) add(spend.lastSession, turn.tokens, turn.costUsd)
  }
  return { ...spend, lastSession: latest === null ? null : spend.lastSession }
}
