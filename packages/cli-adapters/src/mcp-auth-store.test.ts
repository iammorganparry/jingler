import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeInMemorySecretStore } from "./secret-store.js"
import { McpAuthStore } from "./mcp-auth-store.js"
import { makeMcpOAuthProvider } from "./mcp-oauth.js"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("McpAuthStore", () => {
  it("isolates, replaces, and removes per-server credentials", async () => {
    const secrets = await run(makeInMemorySecretStore())
    const store = new McpAuthStore(secrets)

    await run(store.write("linear", { type: "api-key", apiKey: "lin-secret" }))
    await run(store.write("sentry", {
      type: "oauth",
      tokens: { access_token: "access", token_type: "bearer", refresh_token: "refresh" },
      codeVerifier: "verifier",
      state: "state"
    }))

    expect(await run(store.read("linear"))).toEqual({ type: "api-key", apiKey: "lin-secret" })
    expect(await run(store.read("sentry"))).toMatchObject({
      type: "oauth",
      tokens: { access_token: "access", refresh_token: "refresh" }
    })

    await run(store.delete("linear"))
    expect(await run(store.read("linear"))).toBeNull()
    expect(await run(store.read("sentry"))).not.toBeNull()
  })

  it("persists SDK OAuth callbacks and invalidates only the requested scope", async () => {
    const secrets = await run(makeInMemorySecretStore())
    const store = new McpAuthStore(secrets)
    const provider = makeMcpOAuthProvider(
      "linear",
      store,
      "http://127.0.0.1/callback",
      () => {},
      "csrf-state"
    )

    await provider.saveCodeVerifier("pkce-verifier")
    await provider.saveClientInformation?.({ client_id: "client-1" })
    await provider.saveTokens({ access_token: "access", token_type: "bearer", refresh_token: "refresh" })
    expect(await provider.codeVerifier()).toBe("pkce-verifier")
    expect(await provider.clientInformation()).toEqual({ client_id: "client-1" })
    expect(await provider.tokens()).toMatchObject({ access_token: "access", refresh_token: "refresh" })

    await provider.invalidateCredentials?.("tokens")
    expect(await provider.tokens()).toBeUndefined()
    expect(await provider.clientInformation()).toEqual({ client_id: "client-1" })
  })
})
