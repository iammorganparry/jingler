import type { AgentEndpointCatalog, ProviderCatalog } from "@jingler/core"
import { nativeCliEndpointId, ProviderConnectionId, ProviderId, ProviderModelId } from "@jingler/core"
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
        capabilities: { contextWindow: 200_000, reasoning: [], reasoningCanDisable: true, vision: false },
        verification: "certified",
        selectable: true,
        certificationKey: "certified"
      },
      {
        providerId,
        id: staleModelId,
        label: "Claude Opus stale",
        capabilities: { contextWindow: 200_000, reasoning: [], reasoningCanDisable: true, vision: false },
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
        placement="top"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Model: Choose model" }))
    expect(document.querySelector('[data-side="top"][aria-hidden="false"]')).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Search models" })).toBeTruthy()
    expect(screen.getByText("Claude Sonnet")).toBeTruthy()
    expect(screen.getByRole("option", { name: /Claude Sonnet/i }).querySelector("[data-provider-logo]")).toBeTruthy()
    expect(screen.getByText("200k")).toBeTruthy()
    expect(screen.queryByText("anthropic/claude-sonnet · local")).toBeNull()
    expect(screen.queryByText("Claude Opus stale")).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet/i }))
    expect(onSelect).toHaveBeenCalledWith({
      runtimeId: "pi",
      endpointId: "local:pi:claude-max",
      connectionId,
      providerId,
      modelId
    })
  })

  it("groups endpoint models by their visible runtime route", () => {
    const endpointCatalog: AgentEndpointCatalog = {
      refreshedAt: "2026-08-10T00:00:00.000Z",
      stale: false,
      endpoints: [{
        endpoint: {
          id: "local:pi:claude-max" as AgentEndpointCatalog["endpoints"][number]["endpoint"]["id"],
          runtimeId: "pi",
          targetId: "local",
          label: "PI · Max account",
          status: "ready",
          version: null,
          features: {
            steer: "text",
            planReview: true,
            subagentFleet: true,
            backgroundTasks: true
          }
        },
        models: [{
          ...catalog.connections[0]!.models[0]!,
          status: "ready"
        }]
      }]
    }
    const onSelect = vi.fn()
    render(
      <ProviderModelBrowser
        catalog={endpointCatalog}
        endpointId={null}
        connectionId={null}
        modelId={null}
        onSelect={onSelect}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Model: Choose model" }))
    expect(screen.getByRole("group", { name: "PI · Max account" })).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet/i }))
    expect(onSelect).toHaveBeenCalledWith({
      runtimeId: "pi",
      endpointId: "local:pi:claude-max",
      providerId,
      modelId
    })
  })
})


it("selects and displays distinct providers sharing one endpoint and model ID", () => {
  const endpointId = nativeCliEndpointId("desktop", "opencode")
  const alpha = ProviderId.make("alpha")
  const beta = ProviderId.make("beta")
  const sharedId = ProviderModelId.make("shared")
  const models = [alpha, beta].map(providerId => ({ ...catalog.connections[0]!.models[0]!, providerId, id: sharedId, label: `Model ${providerId}`, status: "ready" as const }))
  const endpointCatalog: AgentEndpointCatalog = { refreshedAt: catalog.refreshedAt, stale: false, endpoints: [{ endpoint: { id: endpointId, runtimeId: "opencode", targetId: "desktop", label: "OpenCode CLI", status: "ready", version: "1.18.14", features: { steer: "none", planReview: false, subagentFleet: false, backgroundTasks: false } }, models }] }
  const onSelect = vi.fn()
  render(<ProviderModelBrowser catalog={endpointCatalog} endpointId={endpointId} connectionId={null} providerId={beta} modelId={sharedId} onSelect={onSelect} />)
  fireEvent.click(screen.getByRole("button", { name: "Model: Model beta" }))
  fireEvent.click(screen.getByRole("option", { name: /Model beta/ }))
  expect(onSelect).toHaveBeenLastCalledWith({ runtimeId: "opencode", endpointId, providerId: beta, modelId: sharedId })
  fireEvent.click(screen.getByRole("button", { name: "Model: Model beta" }))
  fireEvent.click(screen.getByRole("option", { name: /Model alpha/ }))
  expect(onSelect).toHaveBeenLastCalledWith({ runtimeId: "opencode", endpointId, providerId: alpha, modelId: sharedId })
})
