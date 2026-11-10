/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentEndpointCatalog, ProviderCatalog, type ProviderConnectionId, type ProviderModelId } from "@jingler/core"
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

const endpointCatalog = Schema.decodeUnknownSync(AgentEndpointCatalog)({
  refreshedAt: "2026-08-10T08:00:00.000Z",
  stale: false,
  endpoints: [
    ...(["claude", "codex", "opencode"] as const).map((runtimeId) => ({
    endpoint: {
      id: `desktop:${runtimeId}:default`,
      runtimeId,
      targetId: "desktop",
      label: runtimeId === "claude" ? "Claude Code" : runtimeId === "codex" ? "Codex CLI" : "OpenCode CLI",
      status: runtimeId === "codex" ? "signed-out" : runtimeId === "opencode" ? "missing" : "ready",
      version: "1.0.0",
      features: { steer: "none", planReview: false, subagentFleet: false, backgroundTasks: false }
    },
    models: []
  })),
    {
      endpoint: {
        id: "device:claude:default",
        runtimeId: "claude",
        targetId: "device",
        label: "Claude Code",
        status: "signed-out",
        version: "1.0.0",
        features: { steer: "none", planReview: false, subagentFleet: false, backgroundTasks: false }
      },
      models: []
    },
    {
      endpoint: {
        id: "device:opencode:default",
        runtimeId: "opencode",
        targetId: "device",
        label: "OpenCode CLI",
        status: "ready",
        version: "1.0.0",
        features: { steer: "none", planReview: false, subagentFleet: false, backgroundTasks: false }
      },
      models: []
    }
  ]
})

describe("ProviderConnectionsSettings", () => {
  it("offers PI and every supported CLI from the add-account panel", () => {
    const nativeEndpointLogin = {
      start: vi.fn(async () => ({ loginId: "login-1", verificationUrl: "https://example.test", userCode: "CODE" })),
      cancel: vi.fn(async () => undefined),
      refresh: vi.fn(async () => false)
    }
    render(
      <ProviderConnectionsSettings
        catalog={Schema.decodeSync(ProviderCatalog)({ connections: [], refreshedAt: "2026-08-10T08:00:00.000Z", stale: false })}
        endpointCatalog={endpointCatalog}
        nativeEndpointLogin={nativeEndpointLogin}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnect={vi.fn()}
      />
    )

    expect(screen.getByRole("button", { name: "PI: Needs provider" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Claude Code: 1/2 ready" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Codex CLI: Sign in required" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "OpenCode CLI: 1/2 ready" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Sign in to Codex CLI" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Codex CLI: Sign in required" }))
    expect(screen.getAllByText("Codex CLI, signed-out, desktop")).toHaveLength(2)
    expect(screen.getAllByRole("button", { name: "Sign in to Codex CLI" })).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Connect Codex" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Claude Code: 1/2 ready" }))
    expect(screen.getByText("claude auth login")).toBeTruthy()
    expect(screen.getAllByText(/Claude Code, .*, device/u).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "PI: Needs provider" }))
    expect(screen.getByRole("button", { name: "Connect Codex" })).toBeTruthy()
  })

  it("adds a provider from settings after onboarding was skipped", () => {
    const onConnect = vi.fn()
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
        onConnect={onConnect}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }))
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code" }))

    expect(onConnect).toHaveBeenNthCalledWith(1, expect.objectContaining({ providerId: "openai-codex", mode: "subscription" }))
    expect(onConnect).toHaveBeenNthCalledWith(2, expect.objectContaining({ providerId: "anthropic", mode: "subscription" }))
  })

  it("adds another account when a provider connection already exists", () => {
    const onConnect = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnect={onConnect}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Add runtime" }))
    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }))

    const request = onConnect.mock.calls[0]?.[0]
    expect(request).toMatchObject({ providerId: "openai-codex", mode: "subscription" })
    expect(["claude-max", "codex-plus"]).not.toContain(request.connectionId)
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
      onConnect: vi.fn(),
    }
    const view = render(
      <ProviderConnectionsSettings catalog={empty} {...props} />
    )

    view.rerender(<ProviderConnectionsSettings catalog={catalog} {...props} />)

    expect(screen.getByText(/Max · desktop · billing: subscription/u)).toBeTruthy()
    expect(screen.queryByText("Add a provider connection")).toBeNull()
  })

  it("reconnects a subscription whose encrypted credential is unavailable", () => {
    const onConnect = vi.fn()
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
        onConnect={onConnect}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))

    expect(onConnect).toHaveBeenCalledWith({ connectionId: "claude-max", providerId: "anthropic", mode: "subscription" })
    expect(screen.queryByPlaceholderText("Claude setup-token")).toBeNull()
  })

  it("shows the real provider brand logo on each provider card, not a letter tile", () => {
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnect={vi.fn()}
      />
    )
    const card = screen.getByRole("region", { name: "Claude Code" })
    expect(card.querySelector("[data-provider-icon='claude']")).toBeTruthy()
    expect(card.querySelector("[data-provider-fallback]")).toBeNull()
  })
  it("marks the default account with a star and signs it out from its menu", async () => {
    const user = userEvent.setup()
    const onLogout = vi.fn()
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        defaultConnectionId={"claude-max" as ProviderConnectionId}
        defaultModelId={"anthropic/claude-test" as ProviderModelId}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={onLogout}
        onConnect={vi.fn()}
      />
    )
    expect(screen.getByLabelText("Default account")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "account-ab12 actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
    expect(onLogout).toHaveBeenCalledWith("claude-max")
  })
  it("shows the pinned account, target, plan, and billing route", () => {
    render(
      <ProviderConnectionsSettings
        catalog={catalog}
        onRefresh={vi.fn()}
        onVerify={vi.fn()}
        onMakeDefault={vi.fn()}
        onLogout={vi.fn()}
        onConnect={vi.fn()}
      />
    )
    expect(screen.getAllByText("Claude CLI subscription").length).toBeGreaterThan(0)
    expect(screen.getAllByText(/account-ab12/u).length).toBeGreaterThan(0)
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
        onConnect={vi.fn()}
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

  it("removes a connection from its account menu without logging out", async () => {
    const user = userEvent.setup()
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
        onConnect={vi.fn()}
      />
    )
    await user.click(screen.getByRole("button", { name: "account-ab12 actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
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
        onConnect={vi.fn()}
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
        onConnect={vi.fn()}
      />
    )

    const chip = screen.getByRole("button", { name: /^Claude Test/u })
    expect(chip.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(chip)
    expect(onMakeDefault).not.toHaveBeenCalled()
  })
})
