import { Option, Schema } from "effect"

/**
 * The Claude CLI's own report of the subscription's rate-limit windows.
 *
 * Every turn the CLI emits a `rate_limit_event` carrying the plan's unified
 * windows (utilization as a 0–1 fraction, resets as epoch seconds). This is
 * the ONLY source Jingler uses for a Claude CLI connection's usage: production
 * code never reads the CLI's credentials (see runtime-architecture.test.ts), so
 * usage is observed from the CLI's output rather than fetched with its token.
 *
 * Captured (2026-09):
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
 *     "unifiedWindows":{"five_hour":{"utilization":0.01,"resetsAt":1790516400},
 *                       "seven_day":{"utilization":0.01,"resetsAt":1790992800}}}}
 */
const UnifiedWindow = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number),
  resetsAt: Schema.optionalWith(Schema.NullOr(Schema.Number), { default: () => null })
})

const RateLimitEvent = Schema.Struct({
  type: Schema.Literal("rate_limit_event"),
  rate_limit_info: Schema.Struct({
    unifiedWindows: Schema.optionalWith(
      Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.NullOr(UnifiedWindow) })),
      { default: () => null }
    )
  })
})

export interface ClaudeCliRateLimits {
  readonly windows: Readonly<Record<string, { readonly utilization: number | null; readonly resetsAt: number | null }>>
  readonly observedAt: string
}

const decodeRateLimitEvent = Schema.decodeUnknownOption(RateLimitEvent)

let latest: ClaudeCliRateLimits | null = null

/**
 * Record a CLI stream record if it is a rate-limit report; anything else is
 * ignored. Returns whether it was recorded, so callers can skip the line.
 */
export const recordClaudeCliRateLimits = (record: unknown, now: () => Date = () => new Date()): boolean => {
  const event = Option.getOrNull(decodeRateLimitEvent(record))
  if (event === null) return false
  const windows = Object.fromEntries(
    Object.entries(event.rate_limit_info.unifiedWindows ?? {}).flatMap(([key, window]) =>
      window === null ? [] : [[key, window] as const]
    )
  )
  if (Object.keys(windows).length === 0) return true
  latest = { windows, observedAt: now().toISOString() }
  return true
}

/** The most recent report, or null before any Claude CLI turn this run. */
export const latestClaudeCliRateLimits = (): ClaudeCliRateLimits | null => latest

/** Test seam: forget what was observed. */
export const resetClaudeCliRateLimits = (): void => {
  latest = null
}
