import { ProviderConnection } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { InMemoryProviderCredentialStore } from "./credential-store.js"
import { makePiCredentialStore } from "./pi-credential-store.js"

const connection = (
  authKind: "claude-setup-token" | "openai-codex-oauth"
) => Schema.decodeUnknownSync(ProviderConnection)({
  id: `${authKind}-connection`,
  providerId: authKind === "claude-setup-token" ? "anthropic" : "openai-codex",
  authKind,
  account: null,
  targetId: "desktop",
  status: "authenticated",
  subscription: {
    entitlement: "active",
    planLabel: null,
    expiresAt: null,
    quotaLabel: null,
    rateLimitLabel: null,
    confirmedBillingRoute: "subscription",
    observedRoute:
      authKind === "claude-setup-token" ? "claude-cli:subscription" : ""
  },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
})

describe("pi credential store", () => {
  it("exposes only the pinned connection and persists refresh rotation", async () => {
    const codex = connection("openai-codex-oauth")
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: codex.id,
      authKind: "openai-codex-oauth",
      access: "access-1",
      refresh: "refresh-1",
      expiresAt: 1
    }))
    const store = makePiCredentialStore(codex, credentials)

    expect(await store.read("anthropic")).toBeUndefined()
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }])
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: 2
    }))
    expect(await Effect.runPromise(credentials.read(codex.id))).toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
      expiresAt: 2
    })
  })

  it("keeps Claude API and subscription credentials pinned without fallback", async () => {
    const subscription = connection("claude-setup-token")
    const api = Schema.decodeUnknownSync(ProviderConnection)({
      ...subscription,
      id: "claude-api",
      authKind: "api-key",
      subscription: { ...subscription.subscription, confirmedBillingRoute: "api", observedRoute: "" }
    })
    const credentials = new InMemoryProviderCredentialStore()
    for (const route of [api, subscription]) {
      await Effect.runPromise(credentials.write({
        connectionId: route.id,
        authKind: route.authKind,
        access: route.authKind === "api-key" ? "test-api-key" : "claude-cli",
        refresh: null,
        expiresAt: null
      }))
    }
    const apiStore = makePiCredentialStore(api, credentials)
    const subscriptionStore = makePiCredentialStore(subscription, credentials)

    expect(await apiStore.read("anthropic")).toEqual({ type: "api_key", key: "test-api-key" })
    expect(await subscriptionStore.read("anthropic")).toMatchObject({ type: "oauth", access: "claude-cli" })
    await apiStore.delete("anthropic")
    expect(await apiStore.read("anthropic")).toBeUndefined()
    expect(await subscriptionStore.read("anthropic")).toMatchObject({ access: "claude-cli" })
  })

  it("synthesizes the non-secret Claude CLI marker without a PI connection credential", async () => {
    const claude = connection("claude-setup-token")
    const credentials = new InMemoryProviderCredentialStore()
    const store = makePiCredentialStore(claude, credentials)

    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "oauth" }])
    expect(await store.read("anthropic")).toEqual({
      type: "oauth",
      access: "claude-cli",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER
    })
    await Effect.runPromise(credentials.write({
      connectionId: claude.id,
      authKind: claude.authKind,
      access: "legacy-setup-token",
      refresh: null,
      expiresAt: null
    }))
    await expect(store.read("anthropic")).rejects.toThrow("Reauthentication required")
  })
})
