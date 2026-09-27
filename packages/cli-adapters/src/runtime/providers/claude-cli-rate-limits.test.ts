import { afterEach, describe, expect, it } from "vitest"
import {
  latestClaudeCliRateLimits,
  recordClaudeCliRateLimits,
  resetClaudeCliRateLimits
} from "./claude-cli-rate-limits.js"
import { claudeCliRateLimitUsage, fetchPiProviderUsage } from "./pi-provider-usage.js"

// Captured from a real Claude CLI turn (2026-09).
const captured = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1790516400,
    rateLimitType: "five_hour",
    unifiedWindows: {
      seven_day: { utilization: 0.01, resetsAt: 1790992800 },
      five_hour: { utilization: 0.034, resetsAt: 1790516400 }
    }
  },
  uuid: "b9d6909e",
  session_id: "2aa27e4b"
}
const at = () => new Date("2026-09-27T10:00:00.000Z")

afterEach(() => resetClaudeCliRateLimits())

describe("recordClaudeCliRateLimits", () => {
  it("records the CLI's unified windows", () => {
    expect(recordClaudeCliRateLimits(captured, at)).toBe(true)
    expect(latestClaudeCliRateLimits()).toEqual({
      windows: {
        seven_day: { utilization: 0.01, resetsAt: 1790992800 },
        five_hour: { utilization: 0.034, resetsAt: 1790516400 }
      },
      observedAt: "2026-09-27T10:00:00.000Z"
    })
  })

  it("ignores every other stream record", () => {
    expect(recordClaudeCliRateLimits({ type: "result", usage: {} })).toBe(false)
    expect(recordClaudeCliRateLimits("not a record")).toBe(false)
    expect(latestClaudeCliRateLimits()).toBeNull()
  })

  it("keeps the last report when a new one carries no windows", () => {
    recordClaudeCliRateLimits(captured, at)
    expect(recordClaudeCliRateLimits({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toBe(true)
    expect(latestClaudeCliRateLimits()?.windows.five_hour?.utilization).toBe(0.034)
  })
})

describe("Claude CLI connection usage", () => {
  const signal = new AbortController().signal
  const read = () => fetchPiProviderUsage({ authKind: "claude-setup-token", access: "claude-cli", accountId: null, signal })

  it("says usage follows the first turn instead of asking for a sign-in", async () => {
    // Regression: the connection showed "Sign in to the Claude CLI" while the
    // CLI was signed in, because nothing could supply its usage.
    expect(await read()).toEqual({
      available: false,
      reason: "Usage appears after the first Claude turn — the Claude CLI reports it with each reply."
    })
  })

  it("shows what the CLI last reported, as percentages, session window first", async () => {
    recordClaudeCliRateLimits(captured, at)
    expect(await read()).toEqual({
      available: true,
      usage: {
        plan: null,
        windows: [
          { label: "Current session", resetsAt: "2026-09-27T13:40:00.000Z", utilization: 3, status: "ok" },
          { label: "Weekly · all models", resetsAt: "2026-10-03T02:00:00.000Z", utilization: 1, status: "ok" }
        ]
      }
    })
  })

  it("flags a window that is nearly exhausted", () => {
    const usage = claudeCliRateLimitUsage({ windows: { five_hour: { utilization: 0.99, resetsAt: null } }, observedAt: "x" })
    expect(usage).toMatchObject({ usage: { windows: [{ utilization: 99, status: "limited", resetsAt: null }] } })
  })
})
