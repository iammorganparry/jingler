import { Effect, Layer } from "effect"
import { describe, expect, it, vi } from "vitest"
import { GitHubAuth, githubPushPermissions, makeGitHubAuthClient } from "./github-auth.js"
import { makeGithubAuthProvider } from "./plugin-auth-github.js"

const STATUS = {
  enabled: true,
  connected: true,
  user: { id: "1", login: "octocat", name: "Octo Cat", avatarUrl: null },
  installations: [
    {
      id: "77",
      account: { id: "2", login: "acme", type: "Organization", avatarUrl: null },
      repositorySelection: "selected",
      permissions: { contents: "read", pull_requests: "write" },
      status: "active",
      suspendedAt: null
    }
  ],
  lastRefreshedAt: "2026-08-04T10:00:00.000Z"
}

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

describe("GitHubAuth desktop grants", () => {
  it("adds workflows write only when an inspected workflow path changed", () => {
    expect(githubPushPermissions(["src/index.ts", "README.md"]))
      .toEqual(["contents:write"])
    expect(githubPushPermissions(["./.github/workflows/ci.yml", "src/index.ts"]))
      .toEqual(["contents:write", "workflows:write"])
    expect(githubPushPermissions([".github/workflows-old/ci.yml"]))
      .toEqual(["contents:write"])
    expect(githubPushPermissions([".github\\workflows\\release.yml"]))
      .toEqual(["contents:write", "workflows:write"])
  })

  it("binds grants to installations and refreshes only near expiry", async () => {
    let now = new Date("2030-01-01T00:00:00.000Z")
    let grantNumber = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/api/github/status") return response(STATUS)
      grantNumber += 1
      return response({
        relayUrl: "https://relay.jingler.test",
        grant: `grant-${grantNumber}`,
        claims: {
          version: 1,
          issuer: "jingler",
          audience: "jingler-github-relay",
          subject: "user-1",
          installationId: "77",
          issuedAt: Math.floor(now.getTime() / 1_000),
          expiresAt: Math.floor(now.getTime() / 1_000) + 60,
          grantId: `id-${grantNumber}`
        }
      })
    })
    const client = makeGitHubAuthClient({
      bearer: async () => "jingler-session",
      fetch,
      baseUrl: () => "https://server.jingler.test",
      now: () => now
    })

    const first = await client.grantForOwner("acme", ["pull_requests:read"])
    const cached = await client.grantForOwner("acme", ["pull_requests:read"])
    expect(first.grant).toBe("grant-1")
    expect(cached).toBe(first)

    now = new Date("2030-01-01T00:00:31.000Z")
    const refreshed = await client.grantForOwner("acme", ["pull_requests:read"])
    expect(refreshed.grant).toBe("grant-2")
    expect(fetch.mock.calls.filter(([input]) => String(input).includes("desktop-grant"))).toHaveLength(2)
  })

  it("registers and grants exactly one opaque relay session", async () => {
    const route = {
      sessionId: "s_one",
      relaySessionId: "opaque_session_route_1234",
      installationId: "77",
      repositoryId: "301",
      pullRequestNumber: 153,
      state: "active",
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/api/github/session-routes" && init?.method === "POST") {
        return response({ route })
      }
      if (url.pathname === "/api/github/session-routes") return response({ routes: [route] })
      if (url.pathname === "/api/github/session-grant") {
        return response({
          relayUrl: "https://relay.jingler.test",
          grant: "session-grant",
          claims: {
            version: 1,
            issuer: "jingler",
            audience: "jingler-github-relay",
            subject: "user-one",
            installationId: route.installationId,
            relaySessionId: route.relaySessionId,
            issuedAt: 1_893_456_000,
            expiresAt: 1_893_456_300,
            grantId: "grant-one"
          }
        })
      }
      return response({ error: "not found" }, 404)
    })
    const client = makeGitHubAuthClient({
      bearer: async () => "session",
      fetch,
      baseUrl: () => "https://server.jingler.test",
      now: () => new Date("2030-01-01T00:00:00.000Z")
    })

    expect(await client.sessionRoutes()).toEqual([route])
    expect(
      await client.upsertSessionRoute({
        sessionId: route.sessionId,
        installationId: route.installationId,
        repositoryId: route.repositoryId,
        pullRequestNumber: route.pullRequestNumber
      })
    ).toEqual(route)
    const grant = await client.grantForSession(route.relaySessionId)
    expect(grant).toMatchObject({
      relaySessionId: route.relaySessionId,
      installationId: route.installationId,
      grant: "session-grant"
    })
    expect(await client.grantForSession(route.relaySessionId)).toBe(grant)
    expect(fetch.mock.calls.filter(([input]) => String(input).includes("session-grant"))).toHaveLength(1)
  })

  it("rejects a suspended installation before requesting a grant", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        ...STATUS,
        installations: [
          {
            ...STATUS.installations[0],
            status: "suspended",
            suspendedAt: "2026-08-04T10:00:00.000Z"
          }
        ]
      })
    )
    const client = makeGitHubAuthClient({
      bearer: async () => "session",
      fetch,
      baseUrl: () => "https://server.jingler.test"
    })
    await expect(client.grantForOwner("acme")).rejects.toMatchObject({
      reason: "installation-suspended",
      installationId: "77"
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("never requests a grant without an authenticated Jingler session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = makeGitHubAuthClient({
      bearer: async () => null,
      fetch,
      baseUrl: () => "https://server.jingler.test"
    })
    await expect(client.status()).rejects.toMatchObject({ reason: "token-expired" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("requests and caches installation credentials by exact scope set", async () => {
    const bodies: unknown[] = []
    let tokenNumber = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname !== "/api/github/installation-credentials") return response(STATUS)
      bodies.push(JSON.parse(String(init?.body)))
      tokenNumber += 1
      return response({
        token: `ghs_token_${tokenNumber}`,
        installationId: "77",
        expiresAt: "2030-01-01T01:00:00.000Z"
      })
    })
    const client = makeGitHubAuthClient({
      bearer: async () => "session",
      fetch,
      baseUrl: () => "https://server.jingler.test",
      now: () => new Date("2030-01-01T00:00:00.000Z")
    })

    const read = await client.credentialsForInstallation("77", "acme/widgets", ["issues:read"])
    expect(await client.credentialsForInstallation("77", "acme/widgets", ["issues:read"])).toBe(read)
    const write = await client.credentialsForInstallation("77", "acme/widgets", ["issues:write"])

    expect(write.token).toBe("ghs_token_2")
    expect(bodies).toEqual([
      { installationId: "77", scopes: ["issues:read", "repository:acme/widgets"] },
      { installationId: "77", scopes: ["issues:write", "repository:acme/widgets"] }
    ])
  })

  it("rejects unqualified or permission-less credential requests locally", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = makeGitHubAuthClient({
      bearer: async () => "session",
      fetch,
      baseUrl: () => "https://server.jingler.test"
    })

    await expect(client.credentialsForInstallation("77", "", ["contents:read"]))
      .rejects.toMatchObject({ reason: "validation" })
    await expect(client.credentialsForInstallation("77", "acme/widgets", []))
      .rejects.toMatchObject({ reason: "validation" })
    await expect(client.credentialsForInstallation("77", "acme/widgets", ["metadata"]))
      .rejects.toMatchObject({ reason: "validation" })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("plugin GitHub authentication", () => {
  it("returns an installation credential for GitHub REST and never a relay grant", async () => {
    const credentialsForOwner = vi.fn(() =>
      Effect.succeed({
        token: "ghs_installation",
        installationId: "77",
        expiresAt: "2030-01-01T00:00:00.000Z"
      })
    )
    const defaultPluginGrant = vi.fn(() =>
      Effect.succeed({
        account: "octocat",
        grant: {
          relayUrl: "https://relay.jingler.test",
          grant: "relay-websocket-grant",
          installationId: "77",
          expiresAt: 1_893_456_000,
          scopes: ["issues:read"]
        }
      })
    )
    const github = Layer.succeed(
      GitHubAuth,
      {
        status: () =>
          Effect.succeed({
            enabled: true,
            connected: true,
            user: { id: "1", login: "octocat", name: null, avatarUrl: null },
            installations: [{
              id: "77",
              account: { id: "2", login: "acme", type: "Organization", avatarUrl: null },
              repositorySelection: "selected",
              permissions: { issues: "write" },
              status: "active",
              suspendedAt: null
            }],
            lastRefreshedAt: "2030-01-01T00:00:00.000Z"
          }),
        credentialsForOwner,
        defaultPluginGrant
      } as never
    )
    const provider = makeGithubAuthProvider((effect) =>
      Effect.runPromise(effect.pipe(Effect.provide(github)))
    )
    const token = await Effect.runPromise(
      provider.getToken(["issues:read", "repository:acme/widgets"])
    )
    expect(token).toEqual({
      accessToken: "ghs_installation",
      account: "octocat",
      apiBaseUrl: "https://api.github.com",
      expiresAt: "2030-01-01T00:00:00.000Z"
    })
    expect(credentialsForOwner).toHaveBeenCalledWith("acme", "acme/widgets", ["issues:read"])
    expect(defaultPluginGrant).not.toHaveBeenCalled()
    expect(token?.accessToken).not.toBe("relay-websocket-grant")
  })

  it("does not mint a plugin credential without an exact repository and permission", async () => {
    const credentialsForOwner = vi.fn()
    const github = Layer.succeed(
      GitHubAuth,
      {
        status: () => Effect.succeed(STATUS),
        credentialsForOwner
      } as never
    )
    const provider = makeGithubAuthProvider((effect) =>
      Effect.runPromise(effect.pipe(Effect.provide(github)))
    )

    await expect(Effect.runPromise(provider.getToken(["issues:read"]))).resolves.toBeNull()
    await expect(
      Effect.runPromise(provider.getToken(["repository:acme/widgets"]))
    ).resolves.toBeNull()
    expect(credentialsForOwner).not.toHaveBeenCalled()
  })
})
