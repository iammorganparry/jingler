import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderModelId
} from "@jingler/core"
import { Effect, Either, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { runLiveTarget, type LiveEvalTarget } from "./live-matrix.js"
import { CORE_PI_SCENARIOS } from "../pi-scenarios.js"

const target = (route: "subscription" | "api"): LiveEvalTarget => ({
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
      confirmedBillingRoute: route
    },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  }),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("openai-codex/gpt-test"),
  accessCredentialEnv: "JINGLER_TEST_LIVE_ACCESS",
  refreshCredentialEnv: "JINGLER_TEST_LIVE_REFRESH",
  expiresAt: Date.now() + 60_000
})

describe("live provider matrix", () => {
  afterEach(() => {
    delete process.env.JINGLER_TEST_LIVE_ACCESS
    delete process.env.JINGLER_TEST_LIVE_REFRESH
  })

  it("rejects subscription metadata that confirms API billing before provider traffic", async () => {
    const result = await Effect.runPromise(Effect.either(
      runLiveTarget(target("api"), "reviewed-release")
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

  it("builds route-specific evidence from every core scenario", async () => {
    process.env.JINGLER_TEST_LIVE_ACCESS = "access-fixture"
    process.env.JINGLER_TEST_LIVE_REFRESH = "refresh-fixture"
    const result = await Effect.runPromise(runLiveTarget(
      target("subscription"),
      "reviewed-release",
      {
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
        observedRoute: "subscription",
        apiBillingFallbackObserved: false
      },
      provenance: "reviewed-release"
    })
    expect(result.certification.results).toHaveLength(CORE_PI_SCENARIOS.length)
  })
})
