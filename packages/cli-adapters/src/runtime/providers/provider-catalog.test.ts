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
import { makeProviderCatalogService, ProviderCatalogError } from "./provider-catalog.js"
import type { DiscoveredProviderModel } from "./provider-catalog.js"

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
const model: DiscoveredProviderModel = {
  providerId,
  id: modelId,
  label: "Claude Sonnet",
  capabilities: {
    contextWindow: 200_000,
    reasoning: ["medium"],
    reasoningCanDisable: true,
    vision: true
  }
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
  readonly discover?: (
    signal: AbortSignal
  ) => Promise<ReadonlyArray<typeof model>>
}) => {
  const certifications = new InMemoryModelCertificationStore()
  await certifications.put(certification())
  return Effect.runPromise(makeProviderCatalogService({
    connections: Effect.succeed([connection]),
    certifications,
    discover: (_connection, signal) =>
      Effect.promise(() => input?.discover?.(signal) ?? Promise.resolve([model])),
    targetAvailable: () => input?.targetAvailable ?? true,
    timeoutMs: input?.timeoutMs,
    now: () => Date.parse("2026-08-10T00:00:00.000Z")
  }))
}

describe("ProviderCatalogService", () => {
  it("skips unavailable connections without hiding healthy provider models", async () => {
    const unavailable = {
      ...connection,
      id: Schema.decodeUnknownSync(ProviderConnection)(
        { ...connection, id: "missing-credential" }
      ).id,
      status: "reauthentication-required" as const
    }
    const discover = vi.fn((candidate: typeof connection) =>
      candidate.status === "authenticated"
        ? Effect.succeed([model])
        : Effect.fail(new ProviderCatalogError({ message: "missing credential" }))
    )
    const service = await Effect.runPromise(makeProviderCatalogService({
      connections: Effect.succeed([unavailable, connection]),
      certifications: new InMemoryModelCertificationStore(),
      discover,
      targetAvailable: () => true
    }))

    const catalog = await Effect.runPromise(service.refresh)

    expect(discover).toHaveBeenCalledOnce()
    expect(catalog.connections).toEqual([
      { connection: unavailable, models: [] },
      expect.objectContaining({ connection, models: [expect.any(Object)] })
    ])
  })

  it("lists certified pi models without consulting executable discovery", async () => {
    const discover = vi.fn(async (_signal: AbortSignal) => [model])
    const catalog = await Effect.runPromise((await make({ discover })).refresh)
    expect(discover).toHaveBeenCalledOnce()
    expect(catalog.connections[0]?.models[0]).toMatchObject({
      verification: "certified",
      selectable: true
    })
  })
})

describe("ProviderCatalogService certification", () => {
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

  it("prefers a current re-verification over older stale evidence", async () => {
    const certifications = new InMemoryModelCertificationStore([
      certification({
        versions: { ...CURRENT_RUNTIME_CONTRACTS, behavior: "old" },
        certifiedAt: "2026-08-09T00:00:00.000Z"
      }),
      certification({ certifiedAt: "2026-08-10T00:00:00.000Z" })
    ])
    const service = await Effect.runPromise(makeProviderCatalogService({
      connections: Effect.succeed([connection]),
      certifications,
      discover: () => Effect.succeed([model]),
      targetAvailable: () => true
    }))

    expect((await Effect.runPromise(service.refresh)).connections[0]?.models[0]).toMatchObject({
      verification: "certified",
      selectable: true
    })
  })

  it("filters a certified model when the execution target is unavailable", async () => {
    const service = await make({ targetAvailable: false })
    expect((await Effect.runPromise(service.refresh)).connections[0]?.models[0]).toMatchObject({
      verification: "target-unavailable",
      selectable: false
    })
  })
})

describe("ProviderCatalogService refresh recovery", () => {
  it("returns the last good catalog as stale after a bounded refresh timeout", async () => {
    let hang = false
    let discoveryAborted = false
    const service = await make({
      timeoutMs: 5,
      discover: (signal) => {
        if (!hang) return Promise.resolve([model])
        signal.addEventListener("abort", () => {
          discoveryAborted = true
        })
        return new Promise(() => undefined)
      }
    })
    await Effect.runPromise(service.refresh)
    hang = true
    expect((await Effect.runPromise(service.refresh)).stale).toBe(true)
    expect(discoveryAborted).toBe(true)
  })

  it("redecorates cached models when certification changes during a failed refresh", async () => {
    const certifications = new InMemoryModelCertificationStore()
    let discoveryFails = false
    const service = await Effect.runPromise(makeProviderCatalogService({
      connections: Effect.succeed([connection]),
      certifications,
      discover: () =>
        discoveryFails
          ? Effect.fail(new ProviderCatalogError({ message: "discovery unavailable" }))
          : Effect.succeed([model]),
      targetAvailable: () => true
    }))

    expect((await Effect.runPromise(service.refresh)).connections[0]?.models[0]).toMatchObject({
      verification: "unverified",
      selectable: false
    })
    await certifications.put(certification())
    discoveryFails = true

    expect((await Effect.runPromise(service.refresh))).toMatchObject({
      stale: true,
      connections: [{ models: [{ verification: "certified", selectable: true }] }]
    })
  })
})

describe("ProviderCatalogService stale retries", () => {
  it("retries discovery after serving stale fallback data", async () => {
    let hang = false
    const discover = vi.fn(() =>
      hang ? new Promise<ReadonlyArray<typeof model>>(() => undefined) : Promise.resolve([model])
    )
    const service = await make({ discover, timeoutMs: 5 })

    await Effect.runPromise(service.refresh)
    hang = true
    expect((await Effect.runPromise(service.refresh)).stale).toBe(true)
    hang = false

    expect((await Effect.runPromise(service.list)).stale).toBe(false)
    expect(discover).toHaveBeenCalledTimes(3)
  })
})
