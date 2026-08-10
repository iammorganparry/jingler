import { ProviderCatalog, type CliInfo } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { UsageService } from "./usage.js"

/**
 * UsageService assembly. The live provider paths spawn their local harnesses, so
 * here we drive scripted mode (JINGLER_SCRIPTED_AGENT) to assert the hermetic
 * behaviour: installed harnesses appear, none claim live data, uninstalled ones
 * are dropped, and a `fetchedAt` stamp is always set. Live reads are covered by
 * the provider-specific usage tests.
 */

const cli = (kind: CliInfo["kind"], available: boolean): CliInfo => ({
  kind,
  label: kind,
  binPath: available ? `/usr/bin/${kind}` : null,
  version: null,
  available
})

const run = <A>(effect: Effect.Effect<A, never, UsageService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UsageService.Default)))

const withScripted = async <A>(fn: () => Promise<A>): Promise<A> => {
  const prev = process.env.JINGLER_SCRIPTED_AGENT
  process.env.JINGLER_SCRIPTED_AGENT = "1"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.JINGLER_SCRIPTED_AGENT
    else process.env.JINGLER_SCRIPTED_AGENT = prev
  }
}

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

  it("lists installed harnesses and stamps fetchedAt (scripted: no live data)", async () => {
    const usage = await withScripted(() =>
      run(UsageService.get([cli("claude", true), cli("codex", true)]))
    )
    expect(usage.providers.map((p) => p.cli)).toStrictEqual(["claude", "codex"])
    expect(usage.providers.every((p) => p.available === false)).toBe(true)
    expect(usage.fetchedAt).not.toBeNull()
  })

  it("omits harnesses that aren't installed", async () => {
    const usage = await withScripted(() =>
      run(UsageService.get([cli("claude", true), cli("cursor", false)]))
    )
    expect(usage.providers.map((p) => p.cli)).toStrictEqual(["claude"])
  })
})
