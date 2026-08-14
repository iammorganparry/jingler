import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchPiProviderUsage, type ProviderUsageRead } from "./pi-provider-usage.js"

const jsonResponse = (body: unknown, ok = true, status = ok ? 200 : 403) =>
  ({ ok, status, json: async () => body }) as Response

afterEach(() => {
  vi.unstubAllGlobals()
})

const signal = new AbortController().signal

const usageOf = (read: ProviderUsageRead) => {
  if (read === null || !read.available) throw new Error("expected available usage")
  return read.usage
}

describe("fetchPiProviderUsage", () => {
  it("maps the Anthropic OAuth limits array (captured shape)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({
        five_hour: { utilization: 14.0, resets_at: "2026-08-14T13:59:59.968275+00:00" },
        seven_day: { utilization: 47.0, resets_at: "2026-08-15T01:59:59.968298+00:00" },
        seven_day_opus: null,
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 14,
            severity: "normal",
            resets_at: "2026-08-14T13:59:59.968275+00:00"
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 47,
            severity: "normal",
            resets_at: "2026-08-15T01:59:59.968298+00:00"
          }
        ]
      })
    ))
    const usage = usageOf(await fetchPiProviderUsage({
      authKind: "claude-setup-token",
      access: "token",
      accountId: null,
      signal
    }))
    expect(usage.windows).toEqual([
      {
        label: "Current session",
        resetsAt: "2026-08-14T13:59:59.968Z",
        utilization: 14,
        status: "ok"
      },
      {
        label: "Weekly · all models",
        resetsAt: "2026-08-15T01:59:59.968Z",
        utilization: 47,
        status: "ok"
      }
    ])
  })

  it("names the credential problem when Anthropic rejects the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(null, false, 401)))
    const read = await fetchPiProviderUsage({
      authKind: "claude-setup-token",
      access: "token",
      accountId: null,
      signal
    })
    expect(read).toMatchObject({ available: false })
    if (read === null || read.available) throw new Error("expected unavailable")
    expect(read.reason).toContain("HTTP 401")
    expect(read.reason).toContain("setup-token")
  })

  it("maps Codex plan windows plus additional per-model limits (captured shape)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 32,
            limit_window_seconds: 604800,
            reset_after_seconds: 490350,
            reset_at: 1787201929
          },
          secondary_window: null
        },
        additional_rate_limits: [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            metered_feature: "codex_bengalfox",
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 5,
                limit_window_seconds: 604800,
                reset_after_seconds: 514159,
                reset_at: 1787225739
              },
              secondary_window: null
            }
          }
        ]
      })
    ))
    const usage = usageOf(await fetchPiProviderUsage({
      authKind: "openai-codex-oauth",
      access: "token",
      accountId: "acct-1",
      signal
    }))
    expect(usage.plan).toBe("Pro")
    expect(usage.windows).toEqual([
      {
        label: "Weekly (7d)",
        resetsAt: new Date(1787201929 * 1000).toISOString(),
        utilization: 32,
        status: "ok"
      },
      {
        label: "GPT-5.3-Codex-Spark · Weekly (7d)",
        resetsAt: new Date(1787225739 * 1000).toISOString(),
        utilization: 5,
        status: "ok"
      }
    ])
  })

  it("degrades unknown shapes to a named unavailable reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ surprise: true })))
    const read = await fetchPiProviderUsage({
      authKind: "claude-setup-token",
      access: "token",
      accountId: null,
      signal
    })
    if (read === null || read.available) throw new Error("expected unavailable")
    expect(read.reason).toContain("no usage windows")

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false, 500)))
    const codex = await fetchPiProviderUsage({
      authKind: "openai-codex-oauth",
      access: "token",
      accountId: null,
      signal
    })
    if (codex === null || codex.available) throw new Error("expected unavailable")
    expect(codex.reason).toContain("HTTP 500")
  })

  it("has no usage surface for API keys", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    expect(
      await fetchPiProviderUsage({
        authKind: "api-key",
        access: "token",
        accountId: null,
        signal
      })
    ).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
