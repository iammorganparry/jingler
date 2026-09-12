import { ProviderConnectionId } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { type CodexOAuthFlow, describeCause, makeAuthBroker } from "./auth-broker.js"
import { InMemoryProviderCredentialStore } from "./credential-store.js"
import { makePiCredentialStore } from "./pi-credential-store.js"

const id = (value: string) => Schema.decodeUnknownSync(ProviderConnectionId)(value)
const activeProbe = vi.fn(async () => ({
  entitlement: "active" as const,
  planLabel: "Subscription",
  quotaLabel: null,
  rateLimitLabel: null,
  billingRoute: "subscription" as const,
  observedRoute: "claude-cli:subscription"
}))

const oauth = (expires: number): CodexOAuthFlow => ({
  login: async () => ({ access: "oauth-access", refresh: "oauth-refresh", expires }),
  refresh: async () => ({ access: "oauth-access-2", refresh: "oauth-refresh-2", expires: expires + 60_000 })
})

describe("AuthBroker", () => {
  it("requires reauthentication when restored metadata has no encrypted credential", async () => {
    const source = await Effect.runPromise(makeAuthBroker({
      credentials: new InMemoryProviderCredentialStore(),
      codexOAuth: oauth(Date.now() + 60_000),
      probe: activeProbe
    }))
    const connection = await Effect.runPromise(source.connectClaudeToken({
      id: "claude-1",
      token: "sk-ant-oat-fixture-value",
      targetId: "desktop"
    }))
    const restored = await Effect.runPromise(makeAuthBroker({
      credentials: new InMemoryProviderCredentialStore(),
      codexOAuth: oauth(Date.now() + 60_000),
      probe: activeProbe
    }))

    await Effect.runPromise(restored.restore([connection]))

    expect((await Effect.runPromise(restored.get(connection.id)))?.status)
      .toBe("reauthentication-required")
  })

  it("requires reauthentication for a legacy Claude setup-token connection", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const broker = await Effect.runPromise(makeAuthBroker({
      credentials,
      codexOAuth: oauth(Date.now() + 60_000),
      probe: activeProbe
    }))
    const connection = await Effect.runPromise(broker.connectClaudeToken({
      id: "claude-legacy",
      token: "ignored",
      targetId: "desktop"
    }))
    await Effect.runPromise(credentials.write({
      connectionId: connection.id,
      authKind: "claude-setup-token",
      access: "legacy-setup-token",
      refresh: null,
      expiresAt: null
    }))

    activeProbe.mockClear()
    await Effect.runPromise(broker.restore([connection]))

    expect((await Effect.runPromise(broker.get(connection.id)))?.status)
      .toBe("reauthentication-required")
    expect((await Effect.runPromiseExit(broker.resolve(connection.id)))._tag)
      .toBe("Failure")
    expect((await Effect.runPromiseExit(broker.refresh(connection.id)))._tag)
      .toBe("Failure")
    expect(activeProbe).not.toHaveBeenCalled()
    await expect(makePiCredentialStore(connection, credentials).read("anthropic"))
      .rejects.toThrow("Reauthentication required")
    await expect(makePiCredentialStore(
      { ...connection, authKind: "api-key" },
      credentials
    ).read("anthropic")).rejects.toThrow("Reauthentication required")
  })

  it("validates the local Claude CLI and stores only a non-secret route marker", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const broker = await Effect.runPromise(makeAuthBroker({ credentials, codexOAuth: oauth(Date.now() + 60_000), probe: activeProbe }))
    const connection = await Effect.runPromise(broker.connectClaudeToken({ id: "claude-1", token: "sk-ant-oat-fixture-value", targetId: "desktop" }))
    expect(connection.status).toBe("authenticated")
    expect(connection.subscription.observedRoute).toBe("claude-cli:subscription")
    expect(connection.account?.fingerprint).not.toContain("fixture-value")
    expect(JSON.stringify(connection)).not.toContain("sk-ant-oat")
    expect((await Effect.runPromise(credentials.read(id("claude-1"))))?.access)
      .toBe("claude-cli")
    expect((await Effect.runPromise(broker.resolve(connection.id))).access)
      .toBe("claude-cli")
  })

  it("runs Codex OAuth and persists rotated access and refresh state", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const flow = oauth(1)
    const broker = await Effect.runPromise(makeAuthBroker({ credentials, codexOAuth: flow, probe: activeProbe, now: () => 10_000, refreshSkewMs: 0 }))
    await Effect.runPromise(broker.startCodexLogin({ id: "codex-1", targetId: "desktop", prompt: async () => "browser", notify: () => undefined }))
    expect((await Effect.runPromise(broker.resolve(id("codex-1")))).access).toBe("oauth-access-2")
    expect((await Effect.runPromise(credentials.read(id("codex-1"))))?.refresh).toBe("oauth-refresh-2")
  })

  it("serializes concurrent refresh for a rotating token", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const flow = oauth(1)
    const refresh = vi.spyOn(flow, "refresh")
    const broker = await Effect.runPromise(makeAuthBroker({ credentials, codexOAuth: flow, probe: activeProbe, now: () => 10_000, refreshSkewMs: 0 }))
    await Effect.runPromise(broker.startCodexLogin({ id: "codex-1", targetId: "desktop", prompt: async () => "browser", notify: () => undefined }))
    await Promise.all([Effect.runPromise(broker.resolve(id("codex-1"))), Effect.runPromise(broker.resolve(id("codex-1")))])
    expect(refresh).toHaveBeenCalledOnce()
  })

  it("keeps an unexpected API billing route unavailable instead of falling back", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const broker = await Effect.runPromise(makeAuthBroker({
      credentials,
      codexOAuth: oauth(Date.now() + 60_000),
      probe: async () => ({
        entitlement: "requires-api-credits",
        planLabel: null,
        quotaLabel: null,
        rateLimitLabel: null,
        billingRoute: "api",
        observedRoute: "fixture-api"
      })
    }))
    const connection = await Effect.runPromise(broker.connectClaudeToken({ id: "claude-1", token: "sk-ant-oat-fixture-value", targetId: "desktop" }))
    expect(connection.status).toBe("entitlement-unconfirmed")
    expect(connection.subscription.confirmedBillingRoute).toBe("api")
  })

  it("cancels login and deletes credentials on logout", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const broker = await Effect.runPromise(makeAuthBroker({ credentials, codexOAuth: oauth(Date.now() + 60_000), probe: activeProbe }))
    await Effect.runPromise(broker.connectClaudeToken({ id: "claude-1", token: "sk-ant-oat-fixture-value", targetId: "desktop" }))
    await Effect.runPromise(broker.logout(id("claude-1")))
    expect(await Effect.runPromise(credentials.read(id("claude-1")))).toBeNull()
    expect((await Effect.runPromise(broker.get(id("claude-1"))))?.status).toBe("disconnected")
  })
})

describe("AuthBroker API connections", () => {
  it("pins API credentials to an explicitly confirmed API route", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const broker = await Effect.runPromise(makeAuthBroker({
      credentials,
      codexOAuth: oauth(Date.now() + 60_000),
      probe: async () => ({
        entitlement: "active",
        planLabel: "API",
        quotaLabel: null,
        rateLimitLabel: null,
        billingRoute: "api",
        observedRoute: "fixture-api"
      })
    }))
    const connection = await Effect.runPromise(
      broker.setApiKey({
        id: "anthropic-api",
        provider: "anthropic",
        apiKey: "api-secret",
        targetId: "desktop"
      })
    )
    expect(connection.authKind).toBe("api-key")
    expect(connection.subscription.confirmedBillingRoute).toBe("api")
    expect(JSON.stringify(connection)).not.toContain("api-secret")
  })

  it("carries the sanitized probe failure into the connection error message", async () => {
    const broker = await Effect.runPromise(makeAuthBroker({
      credentials: new InMemoryProviderCredentialStore(),
      codexOAuth: oauth(Date.now() + 60_000),
      probe: vi.fn(async () => {
        throw new Error('401 {"type":"error","error":{"message":"OAuth access token is invalid."}}')
      })
    }))
    const exit = await Effect.runPromiseExit(broker.connectClaudeToken({
      id: "claude-cause",
      token: "sk-ant-oat01-super-secret-token-value",
      targetId: "desktop"
    }))
    expect(exit._tag).toBe("Failure")
    const rendered = JSON.stringify(exit)
    expect(rendered).toContain("Failed to verify provider entitlement")
    expect(rendered).toContain("OAuth access token is invalid")
  })
})

describe("describeCause", () => {
  it("redacts token-shaped values and bearer headers", () => {
    expect(
      describeCause(new Error("rejected sk-ant-oat01-abcdefghijklmnop by policy"))
    ).toBe("rejected [redacted] by policy")
    expect(describeCause(new Error("sent Authorization: Bearer abc123def456")))
      .toBe("sent Authorization: Bearer [redacted]")
    expect(
      describeCause(new Error(
        `jwt ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(16)} rejected`
      ))
    ).toBe("jwt [redacted] rejected")
  })

  it("collapses whitespace and bounds the length", () => {
    expect(describeCause(new Error("line one\n  line two"))).toBe("line one line two")
    expect(describeCause(new Error("x".repeat(400)))?.length).toBe(301)
    expect(describeCause(new Error(""))).toBeNull()
  })
})
