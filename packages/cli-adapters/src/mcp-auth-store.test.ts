import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeInMemorySecretStore } from "./secret-store.js"
import { McpAuthStore } from "./mcp-auth-store.js"
import { makeMcpOAuthProvider } from "./mcp-oauth.js"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("McpAuthStore", () => {
  it("binds credentials to connection identity and conditionally removes stale keys", async () => {
    const secrets = await run(makeInMemorySecretStore())
    const store = new McpAuthStore(secrets)

    await run(store.write("linear", { type: "api-key", identity: "endpoint-a", apiKey: "old" }))
    expect(await run(store.read("linear", "endpoint-b"))).toBeNull()

    await run(store.write("linear", { type: "api-key", identity: "endpoint-a", apiKey: "new" }))
    await run(store.deleteIf("linear", (credential) =>
      credential.type === "api-key" && credential.identity === "endpoint-a" && credential.apiKey === "old"
    ))
    expect(await run(store.read("linear", "endpoint-a"))).toMatchObject({ apiKey: "new" })

    await run(store.write("linear", { type: "oauth", identity: "endpoint-b" }))
    expect(await run(store.writeIf(
      "linear",
      { type: "oauth", identity: "endpoint-c" },
      () => false,
      () => { throw new Error("expired write started") }
    ))).toBe(false)
    expect(await run(store.read("linear", "endpoint-c"))).toBeNull()
    await run(store.update("linear", "endpoint-a", () => ({
      type: "oauth",
      identity: "endpoint-a",
      tokens: { access_token: "stale", token_type: "bearer" }
    })))
    expect(await run(store.read("linear", "endpoint-b"))).toMatchObject({ identity: "endpoint-b" })

    await run(store.delete("linear"))
    expect(await run(store.read("linear", "endpoint-a"))).toBeNull()
    expect(await run(store.read("linear", "endpoint-b"))).toBeNull()
  })

  it("persists SDK OAuth callbacks and invalidates only the requested scope", async () => {
    const secrets = await run(makeInMemorySecretStore())
    const store = new McpAuthStore(secrets)
    await run(store.write("linear", { type: "oauth", identity: "endpoint-a" }))
    let canInvalidate = false
    const provider = makeMcpOAuthProvider(
      "linear",
      "endpoint-a",
      {},
      store,
      () => {},
      () => canInvalidate
    )

    await provider.saveCodeVerifier("pkce-verifier")
    await provider.saveClientInformation?.({ client_id: "client-1" })
    await provider.saveTokens({ access_token: "access", token_type: "bearer", refresh_token: "refresh" })
    expect(await provider.codeVerifier()).toBe("pkce-verifier")
    expect(await provider.clientInformation()).toEqual({ client_id: "client-1" })
    expect(await provider.tokens()).toMatchObject({ access_token: "access", refresh_token: "refresh" })

    await provider.invalidateCredentials?.("tokens")
    expect(await provider.tokens()).toMatchObject({ access_token: "access" })
    canInvalidate = true
    await provider.invalidateCredentials?.("tokens")
    expect(await provider.tokens()).toBeUndefined()
    expect(await provider.clientInformation()).toEqual({ client_id: "client-1" })
  })
})
