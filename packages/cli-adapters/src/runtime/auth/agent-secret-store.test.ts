import { ProviderConnectionId } from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  readDeviceSecretDocument,
  updateDeviceSecretDocument
} from "../../device-secret-document.js"
import { makeInMemorySecretStore } from "../../secret-store.js"
import { AgentSecretStore } from "./agent-secret-store.js"

const id = (value: string) =>
  Schema.decodeUnknownSync(ProviderConnectionId)(value)

describe("AgentSecretStore", () => {
  it("round-trips API and OAuth credentials in the encrypted document slot", async () => {
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    const store = new AgentSecretStore(backing)

    await Effect.runPromise(store.write({
      connectionId: id("anthropic-api"),
      authKind: "api-key",
      access: "api-secret",
      refresh: null,
      expiresAt: null
    }))
    await Effect.runPromise(store.write({
      connectionId: id("codex-subscription"),
      authKind: "openai-codex-oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expiresAt: 42
    }))

    expect(await Effect.runPromise(store.read(id("anthropic-api")))).toMatchObject({
      authKind: "api-key",
      access: "api-secret"
    })
    expect(await Effect.runPromise(store.read(id("codex-subscription")))).toMatchObject({
      access: "oauth-access",
      refresh: "oauth-refresh",
      expiresAt: 42
    })
  })

  it("serializes concurrent updates and preserves unrelated device secrets", async () => {
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    await updateDeviceSecretDocument(backing, () => ({ clientInstanceId: "client-1" }))
    const store = new AgentSecretStore(backing)

    await Promise.all([
      Effect.runPromise(store.write({ connectionId: id("one"), authKind: "api-key", access: "one", refresh: null, expiresAt: null })),
      Effect.runPromise(store.write({ connectionId: id("two"), authKind: "claude-setup-token", access: "two", refresh: null, expiresAt: null }))
    ])

    expect((await readDeviceSecretDocument(backing)).clientInstanceId).toBe("client-1")
    expect(await Effect.runPromise(store.read(id("one")))).not.toBeNull()
    expect(await Effect.runPromise(store.read(id("two")))).not.toBeNull()
  })

  it("deletes one connection without disturbing another", async () => {
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    const store = new AgentSecretStore(backing)
    await Effect.runPromise(store.write({ connectionId: id("one"), authKind: "api-key", access: "one", refresh: null, expiresAt: null }))
    await Effect.runPromise(store.write({ connectionId: id("two"), authKind: "api-key", access: "two", refresh: null, expiresAt: null }))

    await Effect.runPromise(store.delete(id("one")))

    expect(await Effect.runPromise(store.read(id("one")))).toBeNull()
    expect(await Effect.runPromise(store.read(id("two")))).not.toBeNull()
  })

  it("ignores malformed persisted entries", async () => {
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    await updateDeviceSecretDocument(backing, () => ({
      agentCredentials: { invalid: { authKind: "api-key", access: 123 } }
    }))

    expect(await Effect.runPromise(new AgentSecretStore(backing).read(id("invalid")))).toBeNull()
  })

  it("rejects oversized provider secret payloads", async () => {
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    const store = new AgentSecretStore(backing)

    await expect(Effect.runPromise(store.write({
      connectionId: id("oversized"),
      authKind: "api-key",
      access: "x".repeat(16_385),
      refresh: null,
      expiresAt: null
    }))).rejects.toThrow()
  })
})
