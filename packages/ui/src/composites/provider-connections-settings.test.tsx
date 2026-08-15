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
          capabilities: {
            contextWindow: 200_000,
            reasoning: ["low", "medium", "high"],
            vision: true
          },
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
  it("adds a provider from settings after onboarding was skipped", () => {
    const onStartCodex = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={Schema.decodeSync(ProviderCatalog)({
          connections: [],
          refreshedAt: "2026-08-10T08:00:00.000Z",
          stale: false
        })}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnectClaude={vi.fn()}
        onStartCodex={onStartCodex}
        onSetApiKey={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Open browser" }))
    fireEvent.click(screen.getByRole("button", { name: "Use device code" }))

    expect(onStartCodex).toHaveBeenCalledTimes(2)
    expect(onStartCodex).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "browser"
    )
    expect(onStartCodex).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "device-code"
    )
  })

  it("adds another account when a provider connection already exists", () => {
    const onStartCodex = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnectClaude={vi.fn()}
        onStartCodex={onStartCodex}
        onSetApiKey={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Add account" }))
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }))

    expect(onStartCodex).toHaveBeenCalledWith(expect.any(String), "browser")
  })

  it("selects a connection created while the add form is open", () => {
    const empty = Schema.decodeSync(ProviderCatalog)({
      connections: [],
      refreshedAt: "2026-08-10T08:00:00.000Z",
      stale: false
    })
    const props = {
      onRefresh: vi.fn(),
      onVerify: vi.fn(),
      onMakeDefault: vi.fn(),
      onLogout: vi.fn(),
      onConnectClaude: vi.fn(),
      onStartCodex: vi.fn(),
      onSetApiKey: vi.fn()
    }
    const view = render(
      <ProviderConnectionsSettings catalog={empty} {...props} />
    )

    view.rerender(<ProviderConnectionsSettings catalog={catalog} {...props} />)

    expect(screen.getByText(/Max · desktop · billing: subscription/u)).toBeTruthy()
    expect(screen.queryByText("Add a provider connection")).toBeNull()
  })

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
    expect(
      screen.getByText("200K context · Vision · Reasoning up to High")
    ).toBeTruthy()
  })

  it("makes an unverified model the default from its chip and logs out the selected connection", () => {
    const onMakeDefault = vi.fn()
    const onLogout = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={onMakeDefault}
        onLogout={onLogout}
        onConnectClaude={vi.fn()}
        onStartCodex={vi.fn()}
        onSetApiKey={vi.fn()}
      />
    )
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /^Claude New/u }))
    fireEvent.click(screen.getByRole("button", { name: "Log out" }))
    expect(onMakeDefault).toHaveBeenCalledWith({
      connectionId: "claude-max" as ProviderConnectionId,
      providerId: "anthropic",
      modelId: "anthropic/claude-new" as ProviderModelId
    })
    expect(onLogout).toHaveBeenCalledWith("claude-max")
  })

  it("removes a connection from its list row without selecting it", () => {
    const onLogout = vi.fn()
    const onRemove = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={onLogout}
        onRemove={onRemove}
        onConnectClaude={vi.fn()}
        onStartCodex={vi.fn()}
        onSetApiKey={vi.fn()}
      />
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Claude Pro / Max setup-token connection"
      })
    )
    expect(onRemove).toHaveBeenCalledWith("claude-max")
    expect(onLogout).not.toHaveBeenCalled()
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
    expect(screen.queryByRole("button", { name: "Make default" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /^Claude Test/u }))
    expect(onMakeDefault).toHaveBeenCalledWith({
      connectionId: "claude-max",
      providerId: "anthropic",
      modelId: "anthropic/claude-test"
    })
  })

  it("keeps a stale-certified default usable and re-electable", () => {
    const onMakeDefault = vi.fn()
    const stale = Schema.decodeSync(ProviderCatalog)({
      ...catalog,
      connections: [
        {
          ...catalog.connections[0]!,
          models: [
            {
              ...catalog.connections[0]!.models[0]!,
              verification: "stale",
              selectable: false,
              certificationKey: null
            }
          ]
        }
      ]
    })
    render(
      <ProviderConnectionsSettings
        catalog={stale}
        defaultConnectionId={"claude-max" as ProviderConnectionId}
        defaultModelId={"anthropic/claude-test" as ProviderModelId}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={onMakeDefault}
        onLogout={vi.fn()}
        onConnectClaude={vi.fn()}
        onStartCodex={vi.fn()}
        onSetApiKey={vi.fn()}
      />
    )

    const chip = screen.getByRole("button", { name: /^Claude Test/u })
    expect(chip.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(chip)
    expect(onMakeDefault).not.toHaveBeenCalled()
  })
})
