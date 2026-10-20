import { makeUsageFact, ProviderCatalog, ProviderId } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { UsageService, withApiSpend } from "./usage.js"

const run = <A>(effect: Effect.Effect<A, never, UsageService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UsageService.Default)))

describe("UsageService", () => {
  it("reports the pinned provider connection and billing route", async () => {
    const catalog = Schema.decodeUnknownSync(ProviderCatalog)({
      refreshedAt: "2026-08-10T12:00:00.000Z",
      stale: false,
      connections: [
        {
          connection: {
            id: "claude-max",
            providerId: "anthropic",
            authKind: "claude-setup-token",
            account: { fingerprint: "account-1", displayLabel: "Work Max" },
            targetId: "local",
            status: "authenticated",
            subscription: {
              entitlement: "active",
              planLabel: "Max",
              expiresAt: null,
              quotaLabel: "5-hour window",
              rateLimitLabel: null,
              confirmedBillingRoute: "subscription"
            },
            createdAt: "2026-08-10T12:00:00.000Z",
            updatedAt: "2026-08-10T12:00:00.000Z"
          },
          models: []
        }
      ]
    })

    const usage = await run(UsageService.fromProviderCatalog(catalog))
    expect(usage).toMatchObject({
      fetchedAt: catalog.refreshedAt,
      providers: [
        {
          connectionId: "claude-max",
          providerId: "anthropic",
          authKind: "claude-setup-token",
          billingRoute: "subscription",
          targetId: "local",
          name: "Work Max",
          plan: "Max",
          quotaLabel: "5-hour window"
        }
      ]
    })
  })
})

describe("withApiSpend", () => {
  it("replaces the unavailable state of an api-priced Claude login with its spend", () => {
    const base = {
      name: "Claude", plan: "Enterprise · API pricing", available: false, windows: [],
      providerId: ProviderId.make("anthropic"), authKind: "claude-setup-token" as const, billingRoute: "api" as const
    }
    const sub = { ...base, billingRoute: "subscription" as const, available: false }
    const fact = makeUsageFact({
      id: "a", runId: "a", sessionId: "s", chatId: "c", parentRunId: null, runtimeId: "claude",
      providerId: "anthropic", modelId: "anthropic/opus", kind: "parent", startedAt: Date.parse("2026-10-13T11:00:00Z"),
      endedAt: Date.parse("2026-10-13T11:05:00Z"), totalTokens: 10, costUsd: 0.5, outcome: "success", provenance: "t"
    })
    const out = withApiSpend({ providers: [base, sub], fetchedAt: null }, [fact], new Date("2026-10-13T12:00:00Z"))
    expect(out.providers[0]).toMatchObject({ available: true, spend: { today: { tokens: 10, costUsd: 0.5 } } })
    expect(out.providers[1]).toEqual(sub)
  })
})
