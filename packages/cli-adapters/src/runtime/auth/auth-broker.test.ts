import { ProviderConnectionId } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { type CodexOAuthFlow, makeAuthBroker } from "./auth-broker.js"
import { InMemoryProviderCredentialStore } from "./credential-store.js"

const id = (value: string) => Schema.decodeUnknownSync(ProviderConnectionId)(value)
const activeProbe = vi.fn(async () => ({
  entitlement: "active" as const,
  planLabel: "Subscription",
  quotaLabel: null,
  rateLimitLabel: null,
  billingRoute: "subscription" as const,
  observedRoute: "fixture-subscription"
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

  it("validates a Claude setup-token and exposes only an account fingerprint", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    const broker = await Effect.runPromise(makeAuthBroker({ credentials, codexOAuth: oauth(Date.now() + 60_000), probe: activeProbe }))
    const connection = await Effect.runPromise(broker.connectClaudeToken({ id: "claude-1", token: "sk-ant-oat-fixture-value", targetId: "desktop" }))
    expect(connection.status).toBe("authenticated")
    expect(connection.account?.fingerprint).not.toContain("fixture-value")
    expect(JSON.stringify(connection)).not.toContain("sk-ant-oat")
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
})
