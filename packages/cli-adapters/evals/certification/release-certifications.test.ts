import {
  CURRENT_RUNTIME_CONTRACTS,
  ReleaseModelCandidate,
  type CapabilityProfile,
  type ModelCertification
} from "@jingler/core"
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all"
import { Effect, Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import configuredCandidates from "../../../../config/pi-release-candidates.json" with { type: "json" }
import { buildReleaseCertificationManifest } from "./release-certifications.js"

const coreProfile: CapabilityProfile = {
  id: "core",
  required: true,
  scenarioIds: ["lifecycle.complete", "auth.route-pinned", "diff.complete"]
}

const candidate = Schema.decodeUnknownSync(ReleaseModelCandidate)({
  providerId: "openai-codex",
  modelId: "openai-codex/gpt-test",
  authKind: "openai-codex-oauth"
})

const certification = (
  overrides: Partial<ModelCertification> = {}
): ModelCertification => ({
  providerId: candidate.providerId,
  modelId: candidate.modelId,
  authRoute: {
    kind: candidate.authKind,
    observedRoute: "chatgpt-subscription",
    subscription: true,
    entitlementConfirmed: true,
    apiBillingFallbackObserved: false
  },
  versions: CURRENT_RUNTIME_CONTRACTS,
  provenance: "reviewed-release",
  capabilityProfiles: ["core"],
  results: coreProfile.scenarioIds.map((scenarioId) => ({
    scenarioId,
    status: "passed" as const,
    failures: [],
    durationMs: 1,
    tokens: 1,
    costUsd: 0
  })),
  certifiedAt: "2026-08-11T00:00:00.000Z",
  ...overrides
})

const build = (
  certifications: ReadonlyArray<ModelCertification>,
  candidates: ReadonlyArray<ReleaseModelCandidate> = [candidate]
) => Effect.runPromise(
  buildReleaseCertificationManifest({
    candidates,
    certifications,
    profiles: [coreProfile],
    generatedAt: "2026-08-11T01:00:00.000Z"
  })
)

const buildIssues = async (
  certifications: ReadonlyArray<ModelCertification>,
  profiles: ReadonlyArray<CapabilityProfile> = [coreProfile]
): Promise<ReadonlyArray<string>> => {
  const result = await Effect.runPromise(Effect.either(buildReleaseCertificationManifest({
    candidates: [candidate],
    certifications,
    profiles,
    generatedAt: "2026-08-11T01:00:00.000Z"
  })))
  if (Either.isRight(result)) throw new Error("expected release manifest validation to fail")
  return result.left.issues
}

describe("configured release candidates", () => {
  it("pins the newest supported subscription models from the pi catalog", () => {
    const candidates = Schema.decodeUnknownSync(Schema.Array(ReleaseModelCandidate))(
      configuredCandidates
    )
    expect(candidates).toEqual([
      {
        providerId: "anthropic",
        modelId: "anthropic/claude-fable-5",
        authKind: "claude-setup-token"
      },
      {
        providerId: "openai-codex",
        modelId: "openai-codex/gpt-5.6-sol",
        authKind: "openai-codex-oauth"
      }
    ])
    expect(getBuiltinModel("anthropic", "claude-fable-5")).toBeDefined()
    expect(getBuiltinModel("openai-codex", "gpt-5.6-sol")).toBeDefined()
  })
})

describe("release certifications", () => {
  it("generates a deterministic manifest from exact reviewed route passes", async () => {
    const manifest = await build([certification()])
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      versions: CURRENT_RUNTIME_CONTRACTS,
      requiredScenarioIds: [...coreProfile.scenarioIds].sort(),
      models: [{
        authRoute: { kind: "openai-codex-oauth", observedRoute: "chatgpt-subscription" },
        provenance: "reviewed-release"
      }]
    })
  })

  it("rejects missing, failed, local-only, and stale certifications", async () => {
    expect(await buildIssues([])).toEqual([expect.stringContaining("has no certification")])
    expect(await buildIssues([certification({
      results: certification().results.map((result, index) =>
        index === 0 ? { ...result, status: "failed", failures: ["failed"] } : result
      )
    })])).toEqual(expect.arrayContaining([expect.stringContaining("not a reviewed current passing certification")]))
    expect(await buildIssues([certification({ provenance: "local" })])).toEqual(expect.arrayContaining([expect.stringContaining("not a reviewed current passing certification")]))
    expect(await buildIssues([certification({ versions: { ...CURRENT_RUNTIME_CONTRACTS, diff: "stale" } })])).toEqual(expect.arrayContaining([expect.stringContaining("not a reviewed current passing certification")]))
  })

  it("rejects incomplete core coverage and unconfirmed routes", async () => {
    expect(await buildIssues([certification({
      results: certification().results.slice(0, 1),
      authRoute: { ...certification().authRoute, observedRoute: "" }
    })])).toEqual(expect.arrayContaining([
        expect.stringContaining("has no confirmed provider route"),
        expect.stringContaining("is missing required scenarios")
      ]))
  })

  it("validates optional capability claims before publishing them", async () => {
    const vision: CapabilityProfile = {
      id: "vision",
      required: false,
      scenarioIds: ["vision.image-input"]
    }
    expect(await buildIssues(
      [certification({ capabilityProfiles: ["core", "vision"] })],
      [coreProfile, vision]
    )).toEqual(expect.arrayContaining([expect.stringContaining("is missing vision scenarios")]))
  })
})
