import type { ProviderCatalog } from "@jingler/core"
import { ProviderConnectionId, ProviderId, ProviderModelId } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderModelBrowser } from "./provider-model-browser.js"

const connectionId = Schema.decodeUnknownSync(ProviderConnectionId)("claude-max")
const providerId = Schema.decodeUnknownSync(ProviderId)("anthropic")
const modelId = Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet")
const staleModelId = Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-opus")
const catalog: ProviderCatalog = {
  refreshedAt: "2026-08-10T00:00:00.000Z",
  stale: false,
  connections: [{
    connection: {
      id: connectionId,
      providerId,
      authKind: "claude-setup-token",
      account: { fingerprint: "acct-123", displayLabel: "Max account" },
      targetId: "local",
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
    },
    models: [
      {
        providerId,
        id: modelId,
        label: "Claude Sonnet",
        capabilities: { contextWindow: 200_000, reasoning: [], vision: false },
        verification: "certified",
        selectable: true,
        certificationKey: "certified"
      },
      {
        providerId,
        id: staleModelId,
        label: "Claude Opus stale",
        capabilities: { contextWindow: 200_000, reasoning: [], vision: false },
        verification: "stale",
        selectable: false,
        certificationKey: null
      }
    ]
  }]
}

afterEach(cleanup)

describe("ProviderModelBrowser", () => {
  it("offers only selectable certified models and returns the pinned connection", () => {
    const onSelect = vi.fn()
    render(
      <ProviderModelBrowser
        catalog={catalog}
        connectionId={null}
        modelId={null}
        onSelect={onSelect}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Model: Choose model" }))
    expect(screen.getByText("Claude Sonnet")).toBeTruthy()
    expect(screen.queryByText("Claude Opus stale")).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet/i }))
    expect(onSelect).toHaveBeenCalledWith({ connectionId, providerId, modelId })
  })
})
