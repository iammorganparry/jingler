import { ProviderConnection } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { InMemoryProviderCredentialStore } from "./credential-store.js"
import { makePiCredentialStore } from "./pi-credential-store.js"

const connection = Schema.decodeUnknownSync(ProviderConnection)({
  id: "codex-subscription",
  providerId: "openai-codex",
  authKind: "openai-codex-oauth",
  account: null,
  targetId: "desktop",
  status: "authenticated",
  subscription: {
    entitlement: "active",
    planLabel: null,
    expiresAt: null,
    quotaLabel: null,
    rateLimitLabel: null,
    confirmedBillingRoute: "subscription"
  },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
})

describe("pi credential store", () => {
  it("exposes only the pinned connection and persists refresh rotation", async () => {
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: connection.id,
      authKind: "openai-codex-oauth",
      access: "access-1",
      refresh: "refresh-1",
      expiresAt: 1
    }))
    const store = makePiCredentialStore(connection, credentials)

    expect(await store.read("anthropic")).toBeUndefined()
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }])
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: 2
    }))
    expect(await Effect.runPromise(credentials.read(connection.id))).toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
      expiresAt: 2
    })
  })
})
