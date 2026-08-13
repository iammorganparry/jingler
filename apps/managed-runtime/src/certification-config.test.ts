import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { managedCertificationDocument } from "./certification-config.js"

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64")

describe("managed certification configuration", () => {
  it("accepts bounded schema-validated non-secret evidence", () => {
    const certification = {
      providerId: "openai-codex",
      modelId: "openai-codex/gpt-5.6-sol",
      authRoute: {
        kind: "openai-codex-oauth",
        observedRoute: "chatgpt-codex",
        subscription: true,
        entitlementConfirmed: true,
        apiBillingFallbackObserved: false
      },
      versions: CURRENT_RUNTIME_CONTRACTS,
      provenance: "local",
      capabilityProfiles: ["core"],
      results: [
        {
          scenarioId: "lifecycle.complete",
          status: "passed",
          failures: [],
          durationMs: 1,
          tokens: 1,
          costUsd: 0
        }
      ],
      certifiedAt: "2026-08-13T00:00:00.000Z"
    }

    expect(managedCertificationDocument(encode([certification]))).toBe(
      JSON.stringify([certification])
    )
  })

  it.each([undefined, "", encode({}), encode([{ providerId: "codex" }])])(
    "rejects absent or malformed evidence",
    (value) => {
      expect(managedCertificationDocument(value)).toBeNull()
    }
  )
})
