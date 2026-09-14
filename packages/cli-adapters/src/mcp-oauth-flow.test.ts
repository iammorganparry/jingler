import { createServer } from "node:http"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { McpAuthStore } from "./mcp-auth-store.js"
import { isMcpAuthorizationUrlAllowed, startMcpOAuthAuthorization } from "./mcp-oauth-flow.js"
import type { ParsedMcpServer } from "./runtime/mcp/attachment.js"
import { makeInMemorySecretStore } from "./secret-store.js"

const ALREADY_IN_PROGRESS = /already in progress/
const TIMED_OUT = /timed out/

const ENTRY: ParsedMcpServer = {
  credentialIdentity: "oauth-endpoint",
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

  it("times out the entire network setup and releases the flow guard", async () => {
    const server = createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address !== "object" || address === null) throw new Error("test server did not bind")
    const hanging = {
      ...ENTRY,
      launch: { ...ENTRY.launch, url: `http://127.0.0.1:${address.port}/mcp` }
    }
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    try {
      await expect(Effect.runPromise(startMcpOAuthAuthorization(hanging, secrets, 25)))
        .rejects.toThrow(TIMED_OUT)
      await expect(Effect.runPromise(startMcpOAuthAuthorization(ENTRY, secrets)))
        .rejects.not.toThrow(ALREADY_IN_PROGRESS)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("keeps working tokens and releases the flow guard after setup failure", async () => {
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    const auth = new McpAuthStore(secrets)
    const working = {
      type: "oauth" as const,
      identity: "oauth-endpoint",
      tokens: { access_token: "working", token_type: "bearer" }
    }
    await Effect.runPromise(auth.write("oauth-test", working))

    await expect(Effect.runPromise(startMcpOAuthAuthorization(ENTRY, secrets))).rejects.toThrow()
    expect(await Effect.runPromise(auth.read("oauth-test", "oauth-endpoint"))).toEqual(working)
    await expect(Effect.runPromise(startMcpOAuthAuthorization(ENTRY, secrets)))
      .rejects.not.toThrow(ALREADY_IN_PROGRESS)
  })
})
