/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ProviderCatalog, type ProviderConnectionId, type ProviderModelId } from "@jingler/core"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderConnectionsSettings } from "./provider-connections-settings.js"

afterEach(cleanup)

const catalog = Schema.decodeSync(ProviderCatalog)({
  connections: [
    {
      connection: {
        id: "claude-max",
        providerId: "anthropic",
        authKind: "claude-setup-token",
        account: { fingerprint: "account-ab12", displayLabel: null },
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
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:00:00.000Z"
      },
      models: [
        {
          providerId: "anthropic",
          id: "anthropic/claude-test",
          label: "Claude Test",
          capabilities: { contextWindow: 200_000, reasoning: [], vision: false },
          verification: "certified",
          selectable: true,
          certificationKey: "current-certification"
        },
        {
          providerId: "anthropic",
          id: "anthropic/claude-new",
          label: "Claude New",
          capabilities: { contextWindow: null, reasoning: [], vision: false },
          verification: "unverified",
          selectable: false,
          certificationKey: null
        }
      ]
    }
  ],
  refreshedAt: "2026-08-10T08:00:00.000Z",
  stale: false
})

describe("ProviderConnectionsSettings", () => {
  it("reconnects a subscription whose encrypted credential is unavailable", () => {
    const onConnectClaude = vi.fn()
    const unavailable = Schema.decodeSync(ProviderCatalog)({
      ...catalog,
      connections: catalog.connections.map(({ connection, models }) => ({
        connection: { ...connection, status: "reauthentication-required" },
        models
      }))
    })
    render(
      <ProviderConnectionsSettings
        catalog={unavailable}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnectClaude={onConnectClaude}
        onStartCodex={vi.fn()}
        onSetApiKey={vi.fn()}
      />
    )

    fireEvent.change(screen.getByPlaceholderText("Claude setup-token"), {
      target: { value: "sk-ant-oat-replacement" }
    })
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Claude" }))

    expect(onConnectClaude).toHaveBeenCalledWith(
      "claude-max",
      "sk-ant-oat-replacement"
    )
    expect(
      (screen.getByPlaceholderText("Claude setup-token") as HTMLInputElement).value
    ).toBe("")
  })

  it("shows the pinned account, target, plan, and billing route", () => {
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnectClaude={vi.fn()}
        onStartCodex={vi.fn()}
        onSetApiKey={vi.fn()}
      />
    )
    expect(screen.getAllByText("Claude Pro / Max setup-token").length).toBeGreaterThan(0)
    expect(screen.getByText(/account-ab12/u)).toBeTruthy()
    expect(screen.getByText(/Max · desktop · billing: subscription/u)).toBeTruthy()
  })

  it("verifies unverified models and logs out the selected connection", () => {
    const onVerify = vi.fn()
    const onLogout = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={onVerify}
        onMakeDefault={vi.fn()}
        onLogout={onLogout}
        onConnectClaude={vi.fn()}
        onStartCodex={vi.fn()}
        onSetApiKey={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Verify" }))
    fireEvent.click(screen.getByRole("button", { name: "Log out" }))
    expect(onVerify).toHaveBeenCalledWith(
      "claude-max" as ProviderConnectionId,
      "anthropic/claude-new" as ProviderModelId
    )
    expect(onLogout).toHaveBeenCalledWith("claude-max")
  })

  it("marks only a certified model as the canonical default", () => {
    const onMakeDefault = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={onMakeDefault}
        onLogout={vi.fn()}
        onConnectClaude={vi.fn()}
        onStartCodex={vi.fn()}
        onSetApiKey={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Make default" }))
    expect(onMakeDefault).toHaveBeenCalledWith({
      connectionId: "claude-max",
      providerId: "anthropic",
      modelId: "anthropic/claude-test"
    })
  })
})
