import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { isMcpAuthorizationUrlAllowed, startMcpOAuthAuthorization } from "./mcp-oauth-flow.js"
import type { ParsedMcpServer } from "./runtime/mcp/attachment.js"
import { makeInMemorySecretStore, SecretStoreUnavailable } from "./secret-store.js"

const ALREADY_IN_PROGRESS = /already in progress/

const ENTRY: ParsedMcpServer = {
  server: {
    name: "oauth-test",
    displayName: "OAuth test",
    iconUrl: null,
    authKind: "oauth",
    authState: "needs-auth",
    transport: "http",
    scope: "user",
    target: "http://127.0.0.1:1/mcp",
    envKeys: [],
    headerKeys: [],
    enabled: true
  },
  launch: {
    transport: "http",
    url: "http://127.0.0.1:1/mcp",
    args: [],
    env: {},
    headers: {}
  }
}

describe("MCP OAuth authorization URL policy", () => {
  it("allows HTTPS and native-app loopback HTTP only", () => {
    expect(isMcpAuthorizationUrlAllowed(new URL("https://auth.example.com/authorize"))).toBe(true)
    expect(isMcpAuthorizationUrlAllowed(new URL("http://127.0.0.1:4312/authorize"))).toBe(true)
    expect(isMcpAuthorizationUrlAllowed(new URL("http://localhost:4312/authorize"))).toBe(true)
    expect(isMcpAuthorizationUrlAllowed(new URL("http://auth.example.com/authorize"))).toBe(false)
    expect(isMcpAuthorizationUrlAllowed(new URL("file:///tmp/callback"))).toBe(false)
    expect(isMcpAuthorizationUrlAllowed(new URL("custom-scheme://open"))).toBe(false)
  })

  it("releases the per-server flow guard after an early connection failure", async () => {
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    await expect(Effect.runPromise(startMcpOAuthAuthorization(ENTRY, secrets))).rejects.toThrow()
    await expect(Effect.runPromise(startMcpOAuthAuthorization(ENTRY, secrets)))
      .rejects.not.toThrow(ALREADY_IN_PROGRESS)
  })

  it("releases the flow guard even when encrypted credential writes fail", async () => {
    const base = await Effect.runPromise(makeInMemorySecretStore())
    const unavailable = {
      ...base,
      setDeviceSecrets: () => Effect.fail(new SecretStoreUnavailable({ message: "vault unavailable" }))
    }
    await expect(Effect.runPromise(startMcpOAuthAuthorization(ENTRY, unavailable))).rejects.toThrow()
    await expect(Effect.runPromise(startMcpOAuthAuthorization(ENTRY, unavailable)))
      .rejects.not.toThrow(ALREADY_IN_PROGRESS)
  })
})
