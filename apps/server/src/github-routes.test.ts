import { describe, expect, it } from "vitest"
import type {
  GitHubAuthorizationRecord,
  GitHubCallbackStateKind,
  GitHubCallbackStateRecord,
  GitHubInstallationRecord,
  SaveGitHubConnectionInput
} from "./db/repositories/github-connection-repository.js"
import {
  createGitHubTokenCipher,
  verifyGitHubDesktopGrant,
  type GitHubApiInstallation,
  type GitHubAppClient
} from "./github-app.js"
import {
  createGitHubRoutes,
  type GitHubConnectionStore,
  type GitHubRoutesDependencies
} from "./github-routes.js"

const githubInstallation = (overrides: Partial<GitHubApiInstallation> = {}): GitHubApiInstallation => ({
  id: "99",
  account: { id: "8", login: "acme", type: "Organization", avatarUrl: "avatar" },
  repositorySelection: "all",
  permissions: { contents: "read", pull_requests: "write" },
  suspendedAt: null,
  ...overrides
})

interface Harness {
  readonly routes: ReturnType<typeof createGitHubRoutes>
  readonly authorizations: Map<string, GitHubAuthorizationRecord>
  readonly states: Map<string, GitHubCallbackStateRecord & { readonly stateHash: string }>
  readonly setInstallations: (value: ReadonlyArray<GitHubApiInstallation>) => void
  readonly getSaveCount: () => number
  readonly getRevoked: () => ReadonlyArray<string>
  readonly getRelayRevocations: () => ReadonlyArray<{
    readonly userId: string
    readonly installationId: string
    readonly reason: "disconnect" | "uninstall" | "suspension"
  }>
  readonly getMintedInstallations: () => ReadonlyArray<string>
  readonly getMintedScopes: () => ReadonlyArray<{
    readonly permissions?: Readonly<Record<string, "read" | "write">>
    readonly repositories?: ReadonlyArray<string>
  }>
  readonly setNow: (value: Date) => void
}

const harness = (): Harness => {
  const cipher = createGitHubTokenCipher("test-relay-signing-secret")
  const authorizations = new Map<string, GitHubAuthorizationRecord>()
  const installationRows = new Map<string, Array<GitHubInstallationRecord>>()
  const states = new Map<string, GitHubCallbackStateRecord & { readonly stateHash: string }>()
  const revoked: Array<string> = []
  const relayRevocations: Array<{
    userId: string
    installationId: string
    reason: "disconnect" | "uninstall" | "suspension"
  }> = []
  const mintedInstallations: Array<string> = []
  const mintedScopes: Array<{
    readonly permissions?: Readonly<Record<string, "read" | "write">>
    readonly repositories?: ReadonlyArray<string>
  }> = []
  let installations: ReadonlyArray<GitHubApiInstallation> = [githubInstallation()]
  let now = new Date("2026-08-04T10:00:00Z")
  let sequence = 0
  let saveCount = 0

  const rowsFor = (
    authorizationId: string,
    values: SaveGitHubConnectionInput["installations"],
    refreshedAt: Date
  ): Array<GitHubInstallationRecord> =>
    values.map((value, index) => ({
      id: `row-${sequence}-${index}`,
      authorizationId,
      ...value,
      createdAt: refreshedAt,
      updatedAt: refreshedAt
    }))

  const store: GitHubConnectionStore = {
    createCallbackState: async (input) => {
      states.set(input.stateHash, { ...input, consumedAt: null })
    },
    consumeCallbackState: async (input) => {
      const state = states.get(input.stateHash)
      if (
        !state ||
        state.userId !== input.userId ||
        !input.kinds.includes(state.kind) ||
        state.consumedAt ||
        state.expiresAt <= input.at
      ) {
        return null
      }
      const consumed = { ...state, consumedAt: input.at }
      states.set(input.stateHash, consumed)
      return consumed
    },
    findAuthorizationByUserId: async (userId) => authorizations.get(userId) ?? null,
    listInstallationsByAuthorizationId: async (authorizationId) =>
      installationRows.get(authorizationId) ?? [],
    findInstallationForUser: async (userId, installationId) => {
      const authorization = authorizations.get(userId)
      return authorization
        ? (installationRows
            .get(authorization.id)
            ?.find((installation) => installation.installationId === installationId) ?? null)
        : null
    },
    saveConnection: async (input) => {
      saveCount += 1
      const existing = authorizations.get(input.authorization.userId)
      const record: GitHubAuthorizationRecord = {
        ...input.authorization,
        id: existing?.id ?? input.authorization.id,
        createdAt: existing?.createdAt ?? input.refreshedAt,
        updatedAt: input.refreshedAt,
        lastRefreshedAt: input.refreshedAt
      }
      authorizations.set(record.userId, record)
      installationRows.set(
        record.id,
        rowsFor(record.id, input.installations, input.refreshedAt)
      )
      return record
    },
    replaceInstallations: async (input) => {
      installationRows.set(
        input.authorizationId,
        rowsFor(input.authorizationId, input.installations, input.refreshedAt)
      )
    },
    updateTokens: async (input) => {
      const current = authorizations.get(input.userId)
      if (current) authorizations.set(input.userId, { ...current, ...input })
    },
    disconnect: async (userId) => {
      const authorization = authorizations.get(userId)
      if (authorization) installationRows.delete(authorization.id)
      authorizations.delete(userId)
    }
  }

  const github: GitHubAppClient = {
    authorizationUrl: (state, challenge) =>
      `https://github.test/login/oauth/authorize?state=${state}&code_challenge=${challenge}`,
    installationUrl: async (state) =>
      `https://github.test/apps/jingler/installations/new?state=${state}`,
    exchangeCode: async () => ({
      accessToken: "ghu_user-secret",
      refreshToken: "ghr_refresh-secret",
      accessTokenExpiresAt: new Date("2026-08-04T18:00:00Z"),
      refreshTokenExpiresAt: new Date("2027-02-04T10:00:00Z")
    }),
    refreshUserToken: async () => ({
      accessToken: "ghu_rotated-secret",
      refreshToken: "ghr_rotated-secret",
      accessTokenExpiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1_000),
      refreshTokenExpiresAt: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1_000)
    }),
    getUser: async () => ({ id: "7", login: "octocat", name: "Octo Cat", avatarUrl: null }),
    listInstallations: async () => installations,
    createInstallationAccessToken: async (installationId, scope) => {
      mintedInstallations.push(installationId)
      mintedScopes.push(scope)
      return {
        token: "ghs_installation-secret",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000)
      }
    },
    revokeUserToken: async (token) => {
      revoked.push(token)
    }
  }

  const dependencies: GitHubRoutesDependencies = {
    enabled: true,
    configured: true,
    desktopRedirect: "jingler://auth/callback",
    relayUrl: "https://relay.jingler.test",
    relaySigningSecret: "test-relay-signing-secret",
    getUserId: async (headers) => headers.get("x-test-user"),
    github,
    cipher,
    store,
    revokeRelaySubscription: async (input) => {
      relayRevocations.push(input)
    },
    now: () => now,
    randomState: () => `state-${++sequence}`,
    randomId: () => `id-${sequence}`
  }

  return {
    routes: createGitHubRoutes(() => dependencies),
    authorizations,
    states,
    setInstallations: (value) => {
      installations = value
    },
    getSaveCount: () => saveCount,
    getRevoked: () => revoked,
    getRelayRevocations: () => relayRevocations,
    getMintedInstallations: () => mintedInstallations,
    getMintedScopes: () => mintedScopes,
    setNow: (value) => {
      now = value
    }
  }
}

const asUser = (userId: string): HeadersInit => ({ "x-test-user": userId })

const start = async (
  value: Harness,
  path = "/authorize",
  userId = "user-1"
): Promise<string> => {
  const response = await value.routes.request(path, { headers: asUser(userId) })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { readonly url: string }
  const state = new URL(body.url).searchParams.get("state")
  expect(state).toBeTruthy()
  return state!
}

const connect = async (value: Harness, userId = "user-1"): Promise<Response> => {
  const state = await start(value, "/authorize", userId)
  return value.routes.request(`/callback?code=oauth-code&state=${state}&installation_id=99`, {
    headers: asUser(userId)
  })
}

describe("GitHub connection routes", () => {
  it("completes user authorization and returns renderer-safe identity/installations", async () => {
    const value = harness()
    const callback = await connect(value)
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("jingler://auth/callback?github=connected")

    const persisted = value.authorizations.get("user-1")
    expect(persisted?.accessTokenEncrypted).not.toContain("ghu_user-secret")
    expect(persisted?.refreshTokenEncrypted).not.toContain("ghr_refresh-secret")

    const response = await value.routes.request("/status", { headers: asUser("user-1") })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      enabled: true,
      connected: true,
      user: { id: "7", login: "octocat" },
      installations: [
        {
          id: "99",
          account: { login: "acme" },
          repositorySelection: "all",
          status: "active"
        }
      ]
    })
    expect(JSON.stringify(body)).not.toMatch(/gh[urs]_|accessToken|refreshToken/)
  })

  it("rejects invalid, expired, replayed, and cross-user state without cross-user persistence", async () => {
    const value = harness()
    expect(
      (
        await value.routes.request("/callback?code=oauth-code&state=missing", {
          headers: asUser("user-1")
        })
      ).status
    ).toBe(400)

    const state = await start(value)
    expect(
      (
        await value.routes.request(`/callback?code=oauth-code&state=${state}`, {
          headers: asUser("user-2")
        })
      ).status
    ).toBe(400)
    expect(value.authorizations.has("user-2")).toBe(false)

    const accepted = await value.routes.request(`/callback?code=oauth-code&state=${state}`, {
      headers: asUser("user-1")
    })
    expect(accepted.status).toBe(302)
    const saveCount = value.getSaveCount()
    expect(
      (
        await value.routes.request(`/callback?code=oauth-code&state=${state}`, {
          headers: asUser("user-1")
        })
      ).status
    ).toBe(400)
    expect(value.getSaveCount()).toBe(saveCount)

    const expired = await start(value)
    value.setNow(new Date("2026-08-04T10:11:00Z"))
    expect(
      (
        await value.routes.request(`/callback?code=oauth-code&state=${expired}`, {
          headers: asUser("user-1")
        })
      ).status
    ).toBe(400)
    expect(value.getSaveCount()).toBe(saveCount)
  })

  it("verifies callback installation ids against GitHub before persisting credentials", async () => {
    const value = harness()
    const state = await start(value)
    const response = await value.routes.request(
      `/callback?code=oauth-code&state=${state}&installation_id=123456`,
      { headers: asUser("user-1") }
    )
    expect(response.status).toBe(400)
    expect(value.authorizations.has("user-1")).toBe(false)
    expect(value.getSaveCount()).toBe(0)
  })

  it("binds the setup callback to the installed id and the initiating user", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const state = await start(value, "/install")
    const accepted = await value.routes.request(`/setup?state=${state}&installation_id=99`, {
      headers: asUser("user-1")
    })
    expect(accepted.status).toBe(302)

    const spoofedState = await start(value, "/install")
    const saveCount = value.getSaveCount()
    expect(
      (
        await value.routes.request(`/setup?state=${spoofedState}&installation_id=123456`, {
          headers: asUser("user-1")
        })
      ).status
    ).toBe(400)
    // Reconciliation may update the existing connection, but no spoofed row appears.
    expect(value.getSaveCount()).toBe(saveCount + 1)
  })

  it("reconciles uninstall, suspension, and repository-selection changes", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)

    value.setInstallations([
      githubInstallation({
        repositorySelection: "selected",
        suspendedAt: new Date("2026-08-04T10:05:00Z")
      })
    ])
    const suspended = await value.routes.request("/refresh", {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(await suspended.json()).toMatchObject({
      installations: [
        {
          id: "99",
          repositorySelection: "selected",
          status: "suspended",
          suspendedAt: "2026-08-04T10:05:00.000Z"
        }
      ]
    })
    expect(
      (
        await value.routes.request("/desktop-grant", {
          method: "POST",
          headers: { ...asUser("user-1"), "content-type": "application/json" },
          body: JSON.stringify({ installationId: "99" })
        })
      ).status
    ).toBe(403)
    expect(value.getRelayRevocations()).toContainEqual({
      userId: "user-1",
      installationId: "99",
      reason: "suspension"
    })

    value.setInstallations([])
    const uninstalled = await value.routes.request("/status", { headers: asUser("user-1") })
    expect(await uninstalled.json()).toMatchObject({ connected: true, installations: [] })
    expect(value.getRelayRevocations()).toContainEqual({
      userId: "user-1",
      installationId: "99",
      reason: "uninstall"
    })
  })

  it("issues only a short-lived relay grant for an active installation and disconnects", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const grantResponse = await value.routes.request("/desktop-grant", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({ installationId: "99" })
    })
    const grantBody = (await grantResponse.json()) as { readonly grant: string }
    expect(grantResponse.status).toBe(200)
    expect(
      verifyGitHubDesktopGrant(
        grantBody.grant,
        "test-relay-signing-secret",
        Math.floor(new Date("2026-08-04T10:01:00Z").getTime() / 1_000)
      )
    ).toMatchObject({ subject: "user-1", installationId: "99" })
    expect(JSON.stringify(grantBody)).not.toMatch(/gh[urs]_/)

    const disconnected = await value.routes.request("/disconnect", {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(disconnected.status).toBe(204)
    expect(value.getRevoked()).toEqual(["ghu_user-secret"])
    expect(value.getRelayRevocations()).toContainEqual({
      userId: "user-1",
      installationId: "99",
      reason: "disconnect"
    })
    expect(value.authorizations.has("user-1")).toBe(false)
    const status = await value.routes.request("/status", { headers: asUser("user-1") })
    expect(await status.json()).toMatchObject({ connected: false, installations: [] })
  })

  it("mints installation credentials only for an active installation owned by the signed-in user", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const response = await value.routes.request("/installation-credentials", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        installationId: "99",
        scopes: ["pull_requests:read", "repository:acme/widgets"]
      })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      token: "ghs_installation-secret",
      expiresAt: "2026-08-04T11:00:00.000Z",
      installationId: "99"
    })
    expect(value.getMintedInstallations()).toEqual(["99"])
    expect(value.getMintedScopes()).toEqual([
      { permissions: { pull_requests: "read" }, repositories: ["widgets"] }
    ])
  })

  it("rejects repository-owner mismatches and permission escalation before minting", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)

    for (const scopes of [
      ["repository:other/widgets", "pull_requests:read"],
      ["repository:acme/widgets", "contents:write"]
    ]) {
      const response = await value.routes.request("/installation-credentials", {
        method: "POST",
        headers: { ...asUser("user-1"), "content-type": "application/json" },
        body: JSON.stringify({ installationId: "99", scopes })
      })
      expect(response.status).toBe(403)
    }
    expect(value.getMintedInstallations()).toEqual([])
    expect(value.getMintedScopes()).toEqual([])
  })

  it("never widens empty, metadata-only, repository-less, or unknown scopes", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)

    for (const scopes of [
      [],
      ["metadata:read", "repository:acme/widgets"],
      ["pull_requests:read"],
      ["administration:read", "repository:acme/widgets"]
    ]) {
      const response = await value.routes.request("/installation-credentials", {
        method: "POST",
        headers: { ...asUser("user-1"), "content-type": "application/json" },
        body: JSON.stringify({ installationId: "99", scopes })
      })
      expect(response.status).toBe(403)
    }
    expect(value.getMintedInstallations()).toEqual([])
    expect(value.getMintedScopes()).toEqual([])
  })

  it("rejects cross-user and suspended installation credential requests before minting", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)

    const crossUser = await value.routes.request("/installation-credentials", {
      method: "POST",
      headers: { ...asUser("user-2"), "content-type": "application/json" },
      body: JSON.stringify({ installationId: "99" })
    })
    expect(crossUser.status).toBe(403)
    expect(value.getMintedInstallations()).toEqual([])

    value.setInstallations([
      githubInstallation({ suspendedAt: new Date("2026-08-04T10:05:00Z") })
    ])
    const suspended = await value.routes.request("/installation-credentials", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({ installationId: "99" })
    })
    expect(suspended.status).toBe(403)
    expect(value.getMintedInstallations()).toEqual([])
  })
})
