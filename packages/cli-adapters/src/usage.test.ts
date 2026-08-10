import { ProviderCatalog } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { UsageService } from "./usage.js"

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
