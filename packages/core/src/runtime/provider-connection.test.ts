import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  authStatusForObservedBillingRoute,
  expectedBillingRouteForAuthKind,
  ProviderConnection,
  SessionRuntimeIdentity
} from "./provider-connection.js"

describe("provider connection identity", () => {
  it("keeps provider, authentication, target, and billing route explicit", () => {
    const connection = Schema.decodeUnknownSync(ProviderConnection)({
      id: "connection-1",
      providerId: "anthropic",
      authKind: "claude-setup-token",
      account: { fingerprint: "account-a1", displayLabel: "Claude Max" },
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
    expect(connection.authKind).toBe("claude-setup-token")
    expect(connection.subscription.confirmedBillingRoute).toBe("subscription")
  })

  it("represents unresolved migrated auth and model identity without guessing", () => {
    const identity = Schema.decodeUnknownSync(SessionRuntimeIdentity)({
      connectionId: null,
      providerId: "openai",
      modelId: null,
      piSessionId: null,
      modelSelectionRequired: true,
      connectionSelectionRequired: true,
      legacyCli: "codex",
      legacyModel: "gpt-5",
      legacyResumeId: null
    })
    expect(identity.connectionSelectionRequired).toBe(true)
  })

  it("authenticates only an active entitlement on its credential's expected route", () => {
    expect(expectedBillingRouteForAuthKind("claude-setup-token")).toBe(
      "subscription"
    )
    expect(
      authStatusForObservedBillingRoute(
        "claude-setup-token",
        "unknown",
        "subscription"
      )
    ).toBe("entitlement-unconfirmed")
    expect(
      authStatusForObservedBillingRoute(
        "claude-setup-token",
        "active",
        "api"
      )
    ).toBe("entitlement-unconfirmed")
    expect(
      authStatusForObservedBillingRoute(
        "claude-setup-token",
        "active",
        "subscription"
      )
    ).toBe("authenticated")
  })
})
