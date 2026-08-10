import { describe, expect, it } from "vitest"
import {
  CURRENT_RUNTIME_CONTRACTS,
  certificationKey,
  isCurrentCertification,
  isReleaseCertification,
  type ModelCertification
} from "./model-certification.js"

const certification = (overrides: Partial<ModelCertification> = {}): ModelCertification => ({
  providerId: "openai-codex",
  modelId: "openai-codex/gpt-test",
  authRoute: {
    kind: "openai-codex-oauth",
    observedRoute: "chatgpt-subscription",
    subscription: true,
    entitlementConfirmed: true,
    apiBillingFallbackObserved: false
  },
  versions: { ...CURRENT_RUNTIME_CONTRACTS },
  provenance: "local",
  capabilityProfiles: ["core"],
  results: [{ scenarioId: "core", status: "passed", failures: [], durationMs: 1, tokens: 2, costUsd: 0 }],
  certifiedAt: "2026-08-10T00:00:00.000Z",
  ...overrides
})

describe("model certification", () => {
  it("accepts an exact current certification", () => {
    expect(isCurrentCertification(certification())).toBe(true)
  })

  it("does not accept subscription certification with API billing fallback", () => {
    const value = certification({
      authRoute: { ...certification().authRoute, apiBillingFallbackObserved: true }
    })
    expect(isCurrentCertification(value)).toBe(false)
  })

  it.each(Object.keys(CURRENT_RUNTIME_CONTRACTS))(
    "invalidates a changed %s contract version",
    (field) => {
      const value = certification({
        versions: { ...CURRENT_RUNTIME_CONTRACTS, [field]: "stale" }
      })
      expect(isCurrentCertification(value)).toBe(false)
    }
  )

  it("distinguishes local verification from reviewed release provenance", () => {
    expect(isReleaseCertification(certification())).toBe(false)
    expect(isReleaseCertification(certification({ provenance: "reviewed-release" }))).toBe(true)
  })

  it("keys certifications by authentication route", () => {
    const subscription = certificationKey(certification())
    const api = certificationKey(certification({
      authRoute: {
        kind: "api-key",
        observedRoute: "openai-api",
        subscription: false,
        entitlementConfirmed: true,
        apiBillingFallbackObserved: false
      }
    }))
    expect(api).not.toBe(subscription)
  })
})
