import {
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { projectPiEndpointCatalog } from "./agent-endpoint-catalog.js"

const connectionId = Schema.decodeUnknownSync(ProviderConnectionId)("codex-plus")
const providerId = Schema.decodeUnknownSync(ProviderId)("openai-codex")
const modelId = Schema.decodeUnknownSync(ProviderModelId)("openai-codex/gpt-test")

const catalog = Schema.decodeUnknownSync(ProviderCatalog)({
  refreshedAt: "2026-08-10T00:00:00.000Z",
  stale: false,
  connections: [{
    connection: {
      id: connectionId,
      providerId,
      authKind: "openai-codex-oauth",
      account: { fingerprint: "account-1", displayLabel: "Codex Plus" },
      targetId: "desktop",
      status: "authenticated",
      subscription: {
        entitlement: "active",
        planLabel: "Plus",
        expiresAt: null,
        quotaLabel: null,
        rateLimitLabel: null,
        confirmedBillingRoute: "subscription"
      },
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    },
    models: [{
      providerId,
      id: modelId,
      label: "GPT Test",
      capabilities: {
        contextWindow: 1_000_000,
        reasoning: ["medium"],
        vision: true
      },
      verification: "certified",
      selectable: true,
      certificationKey: "cert-1"
    }]
  }]
})

describe("PI endpoint catalog projection", () => {
  it("keeps provider details behind a selectable PI endpoint", () => {
    expect(projectPiEndpointCatalog(catalog)).toMatchObject({
      endpoints: [{
        endpoint: {
          id: "desktop:pi:codex-plus",
          runtimeId: "pi",
          targetId: "desktop",
          label: "PI · Codex Plus",
          status: "ready"
        },
        models: [{
          providerId,
          id: modelId,
          status: "ready",
          selectable: true
        }]
      }]
    })
  })
})
