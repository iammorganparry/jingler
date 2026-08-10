import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderId,
  ProviderModelId,
  type ModelCertification
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { InMemoryModelCertificationStore } from "../certification/model-certification-store.js"
import { makeProviderCatalogService } from "./provider-catalog.js"

const connection = Schema.decodeUnknownSync(ProviderConnection)({
  id: "claude-max",
  providerId: "anthropic",
  authKind: "claude-setup-token",
  account: { fingerprint: "account-1", displayLabel: "Max" },
  targetId: "desktop",
  status: "authenticated",
  subscription: {
    entitlement: "active",
    planLabel: "Max",
    expiresAt: null,
    quotaLabel: null,
    rateLimitLabel: null,
    confirmedBillingRoute: "subscription"
  },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
})
const providerId = Schema.decodeUnknownSync(ProviderId)("anthropic")
const modelId = Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet")
const model = {
  providerId,
  id: modelId,
  label: "Claude Sonnet",
  capabilities: { contextWindow: 200_000, reasoning: ["medium"], vision: true }
}

const certification = (overrides: Partial<ModelCertification> = {}): ModelCertification => ({
  providerId: "anthropic",
  modelId: "anthropic/claude-sonnet",
  authRoute: {
    kind: "claude-setup-token",
    observedRoute: "subscription",
    subscription: true,
    entitlementConfirmed: true,
    apiBillingFallbackObserved: false
  },
  versions: CURRENT_RUNTIME_CONTRACTS,
  provenance: "local",
  capabilityProfiles: ["core"],
  results: [{ scenarioId: "core", status: "passed", failures: [], durationMs: 1, tokens: 1, costUsd: 0 }],
  certifiedAt: "2026-08-10T00:00:00.000Z",
  ...overrides
})

const make = async (input?: {
  readonly targetAvailable?: boolean
  readonly timeoutMs?: number
  readonly discover?: () => Promise<ReadonlyArray<typeof model>>
}) => {
  const certifications = new InMemoryModelCertificationStore()
  await certifications.put(certification())
  return Effect.runPromise(makeProviderCatalogService({
    connections: Effect.succeed([connection]),
    certifications,
    discover: () => Effect.promise(input?.discover ?? (async () => [model])),
    targetAvailable: () => input?.targetAvailable ?? true,
    timeoutMs: input?.timeoutMs,
    now: () => Date.parse("2026-08-10T00:00:00.000Z")
  }))
}

describe("ProviderCatalogService", () => {
  it("lists certified pi models without consulting executable discovery", async () => {
    const discover = vi.fn(async () => [model])
    const catalog = await Effect.runPromise((await make({ discover })).refresh)
    expect(discover).toHaveBeenCalledOnce()
    expect(catalog.connections[0]?.models[0]).toMatchObject({
      verification: "certified",
      selectable: true
    })
  })

  it("surfaces unverified and stale models but does not select them", async () => {
    const certifications = new InMemoryModelCertificationStore()
    const service = await Effect.runPromise(makeProviderCatalogService({
      connections: Effect.succeed([connection]),
      certifications,
      discover: () => Effect.succeed([model]),
      targetAvailable: () => true
    }))
    expect((await Effect.runPromise(service.refresh)).connections[0]?.models[0]?.verification).toBe("unverified")
    await certifications.put(certification({ versions: { ...CURRENT_RUNTIME_CONTRACTS, prompt: "old" } }))
    expect((await Effect.runPromise(service.refresh)).connections[0]?.models[0]?.verification).toBe("stale")
    expect(await Effect.runPromise(service.selectable)).toStrictEqual([])
  })

  it("filters a certified model when the execution target is unavailable", async () => {
    const service = await make({ targetAvailable: false })
    expect((await Effect.runPromise(service.refresh)).connections[0]?.models[0]).toMatchObject({
      verification: "target-unavailable",
      selectable: false
    })
  })

  it("returns the last good catalog as stale after a bounded refresh timeout", async () => {
    let hang = false
    const service = await make({
      timeoutMs: 5,
      discover: () => hang ? new Promise(() => undefined) : Promise.resolve([model])
    })
    await Effect.runPromise(service.refresh)
    hang = true
    expect((await Effect.runPromise(service.refresh)).stale).toBe(true)
  })
})
