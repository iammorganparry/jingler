// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  CURRENT_RUNTIME_CONTRACTS,
  Environment,
  ProviderCatalog,
  type Session
} from "@jingler/core"
import { Schema } from "effect"
import {
  clampedPlanSplitRatio,
  DEFAULT_PLAN_SPLIT_RATIO,
  resizedPlanSplitRatio
} from "./plan-split-ratio.js"
import { providerRebindOf, providerRecoveryOf } from "./provider-recovery.js"

describe("conversation/plan split ratio", () => {
  it("starts with two thirds for the plan and resizes continuously", () => {
    expect(DEFAULT_PLAN_SPLIT_RATIO).toBeCloseTo(2 / 3)
    expect(clampedPlanSplitRatio(DEFAULT_PLAN_SPLIT_RATIO, 1_200)).toBeCloseTo(2 / 3)
    expect(resizedPlanSplitRatio(0.5, 1_000, -100)).toBeCloseTo(0.6)
    expect(resizedPlanSplitRatio(0.6, 1_000, 50)).toBeCloseTo(0.55)
  })

  it("preserves a usable 360px minimum for both columns", () => {
    expect(clampedPlanSplitRatio(0.9, 801)).toBeCloseTo(0.55)
    expect(clampedPlanSplitRatio(0.1, 801)).toBeCloseTo(0.45)
    expect(clampedPlanSplitRatio(0.9, 721)).toBe(0.5)
  })
})

describe("provider recovery", () => {
  const connectionId = "connection_codex"
  const modelId = "openai-codex/gpt-5.6-sol"
  const catalog = Schema.decodeUnknownSync(ProviderCatalog)({
    refreshedAt: "2026-08-13T00:00:00.000Z",
    stale: false,
    connections: [{
      connection: {
        id: connectionId,
        providerId: "openai-codex",
        authKind: "openai-codex-oauth",
        account: null,
        targetId: "desktop",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: null,
          expiresAt: null,
          quotaLabel: null,
          rateLimitLabel: null,
          confirmedBillingRoute: "subscription"
        },
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z"
      },
      models: [{
        providerId: "openai-codex",
        id: modelId,
        label: "GPT-5.6 Sol",
        capabilities: { contextWindow: null, reasoning: [], vision: false },
        verification: "certified",
        selectable: true,
        certificationKey: "current"
      }]
    }]
  })
  const cloud = Schema.decodeUnknownSync(Environment)({
    kind: "managed",
    id: "managed-cloud",
    name: "Cloud",
    platform: { os: "linux", arch: "x64" },
    capabilities: {
      version: 1,
      capabilities: ["session.start"],
      maxConcurrentSessions: 1,
      runtime: {
        versions: CURRENT_RUNTIME_CONTRACTS,
        toolIds: [],
        resourceIds: [],
        targetId: "managed-cloud"
      }
    },
    state: "online",
    agentVersion: null,
    lastSeenAt: null,
    region: null,
    instanceType: "basic",
    generation: 1,
    createdAt: 1,
    updatedAt: 1
  })

  it("accepts the desktop connection routed to managed Cloud by a capability grant", () => {
    expect(providerRecoveryOf(catalog, {
      connectionId: catalog.connections[0]!.connection.id,
      modelId: catalog.connections[0]!.models[0]!.id,
      targetId: cloud.id,
      target: cloud
    })).toBeUndefined()
  })
})

const rebindModelId = "openai-codex/gpt-5.6-sol"
const entry = (id: string, overrides?: {
  status?: string
  selectable?: boolean
  providerId?: string
}) => ({
  connection: {
    id,
    providerId: overrides?.providerId ?? "openai-codex",
    authKind: "openai-codex-oauth",
    account: null,
    targetId: "desktop",
    status: overrides?.status ?? "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: null,
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: "subscription"
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  },
  models: [{
    providerId: overrides?.providerId ?? "openai-codex",
    id: rebindModelId,
    label: "GPT-5.6 Sol",
    capabilities: { contextWindow: null, reasoning: [], vision: false },
    verification: "certified",
    selectable: overrides?.selectable ?? true,
    certificationKey: "current"
  }]
})
const catalogOf = (...connections: ReadonlyArray<ReturnType<typeof entry>>) =>
  Schema.decodeUnknownSync(ProviderCatalog)({
    refreshedAt: "2026-08-13T00:00:00.000Z",
    stale: false,
    connections
  })
const selection = (connectionId: string) => ({
  connectionId: connectionId as Session["connectionId"],
  providerId: "openai-codex" as Session["providerId"],
  modelId: rebindModelId as Session["modelId"],
  targetId: "desktop"
})

describe("provider rebind", () => {
  it("rebinds to the single reconnected account when the pinned connection is gone", () => {
    const catalog = catalogOf(entry("connection_new"))
    expect(providerRebindOf(catalog, selection("connection_gone"))).toBe("connection_new")
  })

  it("never rebinds while the pinned connection still exists, even unauthenticated", () => {
    const catalog = catalogOf(
      entry("connection_pinned", { status: "expired" }),
      entry("connection_new")
    )
    expect(providerRebindOf(catalog, selection("connection_pinned"))).toBeUndefined()
  })

  it("refuses an ambiguous rebind when several connections would qualify", () => {
    const catalog = catalogOf(entry("connection_a"), entry("connection_b"))
    expect(providerRebindOf(catalog, selection("connection_gone"))).toBeUndefined()
  })

  it("refuses a rebind when the replacement cannot run the pinned model", () => {
    const catalog = catalogOf(entry("connection_new", { selectable: false }))
    expect(providerRebindOf(catalog, selection("connection_gone"))).toBeUndefined()
  })

  it("refuses a rebind onto a different provider's connection", () => {
    const catalog = catalogOf(entry("connection_claude", { providerId: "claude" }))
    expect(providerRebindOf(catalog, selection("connection_gone"))).toBeUndefined()
  })
})
