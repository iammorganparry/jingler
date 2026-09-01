import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderModelId,
  ReleaseModelCandidate
} from "@jingler/core"
import { Effect, Either, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  requireReleaseCandidateMatrix,
  runLiveTarget,
  type LiveEvalTarget
} from "./live-matrix.js"
import { CORE_PI_SCENARIOS } from "../../src/runtime/certification/pi-scenarios.js"

const MATRIX_MISMATCH = /missing release candidates.*unexpected live targets/u

const target = (declaredRoute: "subscription" | "api"): LiveEvalTarget => ({
  connection: Schema.decodeUnknownSync(ProviderConnection)({
    id: "live-openai",
    providerId: "openai-codex",
    authKind: "openai-codex-oauth",
    account: { fingerprint: "account", displayLabel: null },
    targetId: "desktop",
    status: "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: null,
      expiresAt: "2026-08-12T00:00:00.000Z",
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: declaredRoute
    },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  }),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("openai-codex/gpt-test"),
  accessCredentialEnv: "JINGLER_TEST_LIVE_ACCESS",
  refreshCredentialEnv: "JINGLER_TEST_LIVE_REFRESH",
  expiresAt: Date.now() + 60_000
})

afterEach(() => {
  delete process.env.JINGLER_TEST_LIVE_ACCESS
  delete process.env.JINGLER_TEST_LIVE_REFRESH
})

describe("live provider release policy", () => {
  it("requires reviewed live targets to match the exact release candidate routes", async () => {
    const liveTarget = target("subscription")
    const currentCandidate = Schema.decodeUnknownSync(ReleaseModelCandidate)({
      providerId: liveTarget.connection.providerId,
      modelId: liveTarget.modelId,
      authKind: liveTarget.connection.authKind
    })
    await expect(Effect.runPromise(
      requireReleaseCandidateMatrix([liveTarget], [currentCandidate])
    )).resolves.toBeUndefined()

    const staleCandidate = Schema.decodeUnknownSync(ReleaseModelCandidate)({
      ...currentCandidate,
      modelId: "openai-codex/gpt-older"
    })
    await expect(Effect.runPromise(
      requireReleaseCandidateMatrix([liveTarget], [staleCandidate])
    )).rejects.toThrow(MATRIX_MISMATCH)
  })
})

describe("live provider route safeguards", () => {
  it("rejects an API billing route observed by the live credential probe", async () => {
    process.env.JINGLER_TEST_LIVE_ACCESS = "access-fixture"
    process.env.JINGLER_TEST_LIVE_REFRESH = "refresh-fixture"
    const result = await Effect.runPromise(Effect.either(
      runLiveTarget(target("subscription"), "reviewed-release", {
        probe: async () => ({
          entitlement: "requires-api-credits",
          planLabel: null,
          quotaLabel: null,
          rateLimitLabel: null,
          billingRoute: "api",
          observedRoute: "openai-api:openai-responses:https://api.openai.com"
        })
      })
    ))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("subscription billing route")
    }
  })

  it("requires explicit connection-pinned credential environment variables", async () => {
    const result = await Effect.runPromise(Effect.either(
      runLiveTarget(target("subscription"), "local")
    ))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("JINGLER_TEST_LIVE_ACCESS")
    }
  })
})

describe("live provider certification evidence", () => {
  it("builds route-specific evidence from the observed probe and every core scenario", async () => {
    process.env.JINGLER_TEST_LIVE_ACCESS = "access-fixture"
    process.env.JINGLER_TEST_LIVE_REFRESH = "refresh-fixture"
    const result = await Effect.runPromise(runLiveTarget(
      target("subscription"),
      "reviewed-release",
      {
        probe: async () => ({
          entitlement: "active",
          planLabel: "ChatGPT Pro",
          quotaLabel: null,
          rateLimitLabel: null,
          billingRoute: "subscription",
          observedRoute:
            "chatgpt-subscription:openai-codex-responses:https://chatgpt.com/backend-api"
        }),
        runScenario: (_target, _credentials, scenarioId) => Effect.succeed({
          scenarioId,
          observations: scenarioId === "auth.route-pinned"
            ? [
                { kind: "auth-route", route: "openai-codex-oauth" },
                { kind: "event", tag: "Done" }
              ]
            : [{ kind: "event", tag: "Done" }],
          durationMs: 1,
          tokens: 1,
          costUsd: 0,
          versions: CURRENT_RUNTIME_CONTRACTS
        })
      }
    ))
    expect(result.certification).toMatchObject({
      authRoute: {
        kind: "openai-codex-oauth",
        observedRoute:
          "chatgpt-subscription:openai-codex-responses:https://chatgpt.com/backend-api",
        apiBillingFallbackObserved: false
      },
      provenance: "reviewed-release"
    })
    expect(result.certification.results).toHaveLength(CORE_PI_SCENARIOS.length)
  })
})

describe("live provider observed metadata", () => {
  it("does not trust stale billing metadata supplied by the matrix", async () => {
    process.env.JINGLER_TEST_LIVE_ACCESS = "access-fixture"
    process.env.JINGLER_TEST_LIVE_REFRESH = "refresh-fixture"
    const observedConnections: Array<LiveEvalTarget["connection"]> = []
    await Effect.runPromise(runLiveTarget(target("api"), "local", {
      probe: async () => ({
        entitlement: "active",
        planLabel: "ChatGPT Pro",
        quotaLabel: "available",
        rateLimitLabel: null,
        billingRoute: "subscription",
        observedRoute:
          "chatgpt-subscription:openai-codex-responses:https://chatgpt.com/backend-api"
      }),
      runScenario: (verifiedTarget, _credentials, scenarioId) => {
        observedConnections.push(verifiedTarget.connection)
        return Effect.succeed({
          scenarioId,
          observations: scenarioId === "auth.route-pinned"
            ? [
                { kind: "auth-route", route: "openai-codex-oauth" },
                { kind: "event", tag: "Done" }
              ]
            : [{ kind: "event", tag: "Done" }],
          durationMs: 1,
          tokens: 1,
          costUsd: 0,
          versions: CURRENT_RUNTIME_CONTRACTS
        })
      }
    }))
    expect(observedConnections).not.toHaveLength(0)
    expect(observedConnections[0]?.subscription).toMatchObject({
      entitlement: "active",
      planLabel: "ChatGPT Pro",
      quotaLabel: "available",
      confirmedBillingRoute: "subscription"
    })
  })
})
