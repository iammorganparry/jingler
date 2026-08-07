import { describe, expect, it } from "vitest"
import type {
  GitHubAuthorizationRecord,
  GitHubCallbackStateKind,
  GitHubCallbackStateRecord,
  GitHubInstallationRecord,
  GitHubRelayRegistrationMutation,
  GitHubRelayRegistrationState,
  SaveGitHubConnectionInput
} from "./db/repositories/github-connection-repository.js"
import type {
  GitHubSessionRouteMutation,
  GitHubSessionRouteRecord,
  GitHubSessionRouteState
} from "./db/repositories/github-session-route-repository.js"
import {
  createGitHubTokenCipher,
  verifyGitHubDesktopGrant,
  type GitHubApiInstallation,
  type GitHubApiRepository,
  type GitHubAppClient
} from "./github-app.js"
import {
  createGitHubRoutes,
  type GitHubConnectionStore,
  type GitHubRoutesDependencies,
  type GitHubSessionRouteStore
} from "./github-routes.js"

const githubInstallation = (
  overrides: Partial<GitHubApiInstallation> = {}
): GitHubApiInstallation => ({
  id: "99",
  account: {
    id: "8",
    login: "acme",
    type: "Organization",
    avatarUrl: "avatar"
  },
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
  readonly setRepositories: (value: ReadonlyArray<GitHubApiRepository>) => void
  readonly getSaveCount: () => number
  readonly getRevoked: () => ReadonlyArray<string>
  readonly getRelayRegistrations: () => ReadonlyArray<{
    readonly mutationId: string
    readonly userId: string
    readonly installationId: string
    readonly state: GitHubRelayRegistrationState
  }>
  readonly setRelayAvailable: (available: boolean) => void
  readonly getPendingRelayMutations: () => number
  readonly getMintedInstallations: () => ReadonlyArray<string>
  readonly getMintedScopes: () => ReadonlyArray<{
    readonly permissions?: Readonly<Record<string, "read" | "write">>
    readonly repositories?: ReadonlyArray<string>
  }>
  readonly getCreatedPullRequests: () => ReadonlyArray<{
    readonly accessToken: string
    readonly repository: string
    readonly head: string
    readonly base: string
  }>
  readonly getSessionRelayRegistrations: () => ReadonlyArray<{
    readonly mutationId: string
    readonly state: GitHubSessionRouteState
    readonly userId: string
    readonly relaySessionId: string
    readonly installationId: string
    readonly repositoryId: string
    readonly pullRequestNumber: number
  }>
  readonly getPendingSessionMutations: () => number
  readonly setNow: (value: Date) => void
}

const harness = (): Harness => {
  const cipher = createGitHubTokenCipher("test-token-encryption-key")
  const authorizations = new Map<string, GitHubAuthorizationRecord>()
  const installationRows = new Map<string, Array<GitHubInstallationRecord>>()
  const states = new Map<string, GitHubCallbackStateRecord & { readonly stateHash: string }>()
  const revoked: Array<string> = []
  const relayRegistrations: Array<{
    mutationId: string
    userId: string
    installationId: string
    state: GitHubRelayRegistrationState
    generation: number
  }> = []
  const relayMutations = new Map<string, GitHubRelayRegistrationMutation>()
  const sessionRoutes = new Map<string, GitHubSessionRouteRecord>()
  const sessionMutations = new Map<string, GitHubSessionRouteMutation>()
  const sessionRelayRegistrations: Array<{
    mutationId: string
    state: GitHubSessionRouteState
    userId: string
    relaySessionId: string
    installationId: string
    repositoryId: string
    pullRequestNumber: number
    generation: number
  }> = []
  const mintedInstallations: Array<string> = []
  const mintedScopes: Array<{
    readonly permissions?: Readonly<Record<string, "read" | "write">>
    readonly repositories?: ReadonlyArray<string>
  }> = []
  const createdPullRequests: Array<{
    accessToken: string
    repository: string
    head: string
    base: string
  }> = []
  let installations: ReadonlyArray<GitHubApiInstallation> = [githubInstallation()]
  let repositories: ReadonlyArray<GitHubApiRepository> = [{ id: "301", fullName: "acme/widget" }]
  let now = new Date("2026-08-04T10:00:00Z")
  let sequence = 0
  let saveCount = 0
  let relayAvailable = true

  const queueRelayMutation = (
    userId: string,
    installationId: string,
    desiredState: GitHubRelayRegistrationState
  ): void => {
    const id = `relay-${userId}-${installationId}`
    relayMutations.set(id, {
      id,
      userId,
      installationId,
      desiredState,
      generation: (relayMutations.get(id)?.generation ?? 0) + 1,
      attemptCount: 0
    })
  }

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
      const previous = existing ? (installationRows.get(existing.id) ?? []) : []
      const record: GitHubAuthorizationRecord = {
        ...input.authorization,
        id: existing?.id ?? input.authorization.id,
        createdAt: existing?.createdAt ?? input.refreshedAt,
        updatedAt: input.refreshedAt,
        lastRefreshedAt: input.refreshedAt
      }
      authorizations.set(record.userId, record)
      installationRows.set(record.id, rowsFor(record.id, input.installations, input.refreshedAt))
      for (const installation of input.installations) {
        queueRelayMutation(
          input.authorization.userId,
          installation.installationId,
          installation.suspendedAt ? "suspended" : "active"
        )
      }
      for (const installation of previous) {
        if (
          !input.installations.some(
            (current) => current.installationId === installation.installationId
          )
        ) {
          queueRelayMutation(input.authorization.userId, installation.installationId, "removed")
        }
      }
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
      if (authorization) {
        for (const installation of installationRows.get(authorization.id) ?? []) {
          queueRelayMutation(userId, installation.installationId, "removed")
        }
        installationRows.delete(authorization.id)
      }
      authorizations.delete(userId)
    },
    listPendingRelayMutations: async () => [...relayMutations.values()],
    markRelayMutationDelivered: async (id) => {
      relayMutations.delete(id)
    },
    markRelayMutationFailed: async (input) => {
      const current = relayMutations.get(input.id)
      if (current) {
        relayMutations.set(input.id, {
          ...current,
          attemptCount: current.attemptCount + 1
        })
      }
    }
  }

  const sessionRouteStore: GitHubSessionRouteStore = {
    listByUserId: async (userId) =>
      [...sessionRoutes.values()].filter((route) => route.userId === userId),
    findForUser: async (userId, relaySessionId) => {
      const route = sessionRoutes.get(relaySessionId)
      return route?.userId === userId ? route : null
    },
    upsertActive: async (input) => {
      const conflicting = [...sessionRoutes.values()].find(
        (route) =>
          route.installationId === input.installationId &&
          route.repositoryId === input.repositoryId &&
          route.pullRequestNumber === input.pullRequestNumber &&
          route.state !== "removed" &&
          (route.userId !== input.userId || route.sessionId !== input.sessionId)
      )
      if (conflicting) throw new Error("pull request already linked")
      const existing = [...sessionRoutes.values()].find(
        (route) => route.userId === input.userId && route.sessionId === input.sessionId
      )
      const identityChanged =
        existing !== undefined &&
        (existing.installationId !== input.installationId ||
          existing.repositoryId !== input.repositoryId ||
          existing.pullRequestNumber !== input.pullRequestNumber)
      const generationIncrement = identityChanged && existing.state !== "removed" ? 2 : 1
      const route: GitHubSessionRouteRecord = {
        id: existing?.id ?? `route-${sessionRoutes.size + 1}`,
        userId: input.userId,
        sessionId: input.sessionId,
        relaySessionId: identityChanged
          ? input.relaySessionId
          : (existing?.relaySessionId ?? input.relaySessionId),
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        pullRequestNumber: input.pullRequestNumber,
        state: "active",
        generation: (existing?.generation ?? 0) + generationIncrement,
        archivedAt: null,
        unlinkedAt: null,
        createdAt: existing?.createdAt ?? input.at,
        updatedAt: input.at
      }
      if (identityChanged && existing.relaySessionId !== route.relaySessionId) {
        sessionRoutes.delete(existing.relaySessionId)
      }
      sessionRoutes.set(route.relaySessionId, route)
      if (identityChanged && existing.state !== "removed") {
        const removedId = `session-mutation-${route.relaySessionId}-${route.generation - 1}`
        sessionMutations.set(removedId, {
          id: removedId,
          userId: existing.userId,
          relaySessionId: existing.relaySessionId,
          installationId: existing.installationId,
          repositoryId: existing.repositoryId,
          pullRequestNumber: existing.pullRequestNumber,
          desiredState: "removed",
          generation: route.generation - 1,
          attemptCount: 0
        })
      }
      const activeId = `session-mutation-${route.relaySessionId}-${route.generation}`
      sessionMutations.set(activeId, {
        id: activeId,
        userId: route.userId,
        relaySessionId: route.relaySessionId,
        installationId: route.installationId,
        repositoryId: route.repositoryId,
        pullRequestNumber: route.pullRequestNumber,
        desiredState: route.state,
        generation: route.generation,
        attemptCount: 0
      })
      return route
    },
    setState: async (input) => {
      const route = sessionRoutes.get(input.relaySessionId)
      if (!route || route.userId !== input.userId) return null
      const updated: GitHubSessionRouteRecord = {
        ...route,
        state: input.state,
        archivedAt: input.state === "archived" ? input.at : null,
        unlinkedAt: input.state === "removed" ? input.at : null,
        generation: route.generation + 1,
        updatedAt: input.at
      }
      sessionRoutes.set(updated.relaySessionId, updated)
      const mutationId = `session-mutation-${updated.relaySessionId}-${updated.generation}`
      sessionMutations.set(mutationId, {
        id: mutationId,
        userId: updated.userId,
        relaySessionId: updated.relaySessionId,
        installationId: updated.installationId,
        repositoryId: updated.repositoryId,
        pullRequestNumber: updated.pullRequestNumber,
        desiredState: updated.state,
        generation: updated.generation,
        attemptCount: 0
      })
      return updated
    },
    removeAllForUser: async (userId, at) => {
      for (const route of [...sessionRoutes.values()]) {
        if (route.userId === userId) {
          await sessionRouteStore.setState({
            userId,
            relaySessionId: route.relaySessionId,
            state: "removed",
            at
          })
        }
      }
    },
    listPendingMutations: async () => [...sessionMutations.values()],
    markMutationDelivered: async (id) => {
      sessionMutations.delete(id)
    },
    markMutationFailed: async (input) => {
      const mutation = [...sessionMutations.values()].find((value) => value.id === input.id)
      if (mutation) {
        sessionMutations.set(mutation.id, {
          ...mutation,
          attemptCount: mutation.attemptCount + 1
        })
      }
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
    getUser: async () => ({
      id: "7",
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: null
    }),
    listInstallations: async () => installations,
    listInstallationRepositories: async () => repositories,
    createInstallationAccessToken: async (installationId, scope) => {
      mintedInstallations.push(installationId)
      mintedScopes.push(scope)
      return {
        token: "ghs_installation-secret",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000)
      }
    },
    createPullRequest: async (accessToken, input) => {
      createdPullRequests.push({
        accessToken,
        repository: input.repository,
        head: input.head,
        base: input.base
      })
      return 1731
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
    sessionRoutes: sessionRouteStore,
    syncRelayRegistration: async (input) => {
      if (!relayAvailable) throw new Error("relay unavailable")
      relayRegistrations.push(input)
    },
    syncRelaySessionRoute: async (input) => {
      if (!relayAvailable) throw new Error("relay unavailable")
      sessionRelayRegistrations.push(input)
    },
    now: () => now,
    randomState: () => `state-${++sequence}`,
    randomId: () => `id-${sequence}`,
    randomRelaySessionId: () => `opaque_session_identifier_${++sequence}`
  }

  return {
    routes: createGitHubRoutes(() => dependencies),
    authorizations,
    states,
    setInstallations: (value) => {
      installations = value
    },
    setRepositories: (value) => {
      repositories = value
    },
    getSaveCount: () => saveCount,
    getRevoked: () => revoked,
    getRelayRegistrations: () => relayRegistrations,
    setRelayAvailable: (available) => {
      relayAvailable = available
    },
    getPendingRelayMutations: () => relayMutations.size,
    getMintedInstallations: () => mintedInstallations,
    getMintedScopes: () => mintedScopes,
    getCreatedPullRequests: () => createdPullRequests,
    getSessionRelayRegistrations: () => sessionRelayRegistrations,
    getPendingSessionMutations: () => sessionMutations.size,
    setNow: (value) => {
      now = value
    }
  }
}

const asUser = (userId: string): HeadersInit => ({ "x-test-user": userId })

const start = async (value: Harness, path = "/authorize", userId = "user-1"): Promise<string> => {
  const response = await value.routes.request(path, {
    headers: asUser(userId)
  })
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

    // A status read is persisted state, not an implicit GitHub refresh.
    value.authorizations.set("user-1", {
      ...persisted!,
      githubLogin: "stale-login",
      githubName: "Stale Name"
    })
    const saveCount = value.getSaveCount()

    const response = await value.routes.request("/status", {
      headers: asUser("user-1")
    })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      enabled: true,
      connected: true,
      user: { id: "7", login: "stale-login", name: "Stale Name" },
      installations: [
        {
          id: "99",
          account: { login: "acme" },
          repositorySelection: "all",
          status: "active"
        }
      ]
    })
    expect(value.getSaveCount()).toBe(saveCount)
    expect(JSON.stringify(body)).not.toMatch(/gh[urs]_|accessToken|refreshToken/)

    const refreshed = await value.routes.request("/refresh", {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(await refreshed.json()).toMatchObject({
      user: { id: "7", login: "octocat", name: "Octo Cat" }
    })
    expect(value.getSaveCount()).toBe(saveCount + 1)
  })

  it("completes GitHub's combined install-and-authorize callback", async () => {
    const value = harness()
    const state = await start(value, "/install")
    const callback = await value.routes.request(
      `/callback?code=oauth-code&state=${state}&installation_id=99`,
      { headers: asUser("user-1") }
    )

    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("jingler://auth/callback?github=connected")
    expect(value.authorizations.get("user-1")).toMatchObject({
      githubUserId: "7",
      githubLogin: "octocat"
    })
  })

  it("rotates expiring user credentials back into encrypted persistence", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    value.setNow(new Date("2026-08-04T17:59:30Z"))

    const refreshed = await value.routes.request("/refresh", {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(refreshed.status).toBe(200)

    const persisted = value.authorizations.get("user-1")!
    expect(persisted.accessTokenEncrypted).not.toContain("ghu_rotated-secret")
    expect(persisted.refreshTokenEncrypted).not.toContain("ghr_rotated-secret")
    const cipher = createGitHubTokenCipher("test-token-encryption-key")
    expect(cipher.decrypt(persisted.accessTokenEncrypted)).toBe("ghu_rotated-secret")
    expect(cipher.decrypt(persisted.refreshTokenEncrypted!)).toBe("ghr_rotated-secret")
  })

  it("authenticates the callback on the state alone, binding it to the state's owner", async () => {
    const value = harness()
    // Unknown state — nothing to consume.
    expect((await value.routes.request("/callback?code=oauth-code&state=missing")).status).toBe(400)

    // The callback carries no session cookie — the OS browser GitHub redirects
    // has none. The unguessable state is the sole authenticator, and it binds
    // the connection to its owner (user-1), never to anyone else.
    const state = await start(value, "/authorize", "user-1")
    const accepted = await value.routes.request(`/callback?code=oauth-code&state=${state}`)
    expect(accepted.status).toBe(302)
    expect(value.authorizations.has("user-1")).toBe(true)
    expect(value.authorizations.has("user-2")).toBe(false)

    // Single-use: the consumed state cannot be replayed.
    const saveCount = value.getSaveCount()
    expect((await value.routes.request(`/callback?code=oauth-code&state=${state}`)).status).toBe(
      400
    )
    expect(value.getSaveCount()).toBe(saveCount)

    // Expired state is refused.
    const expired = await start(value, "/authorize", "user-1")
    value.setNow(new Date("2026-08-04T10:11:00Z"))
    expect((await value.routes.request(`/callback?code=oauth-code&state=${expired}`)).status).toBe(
      400
    )
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
    expect(value.getRelayRegistrations()).toContainEqual({
      mutationId: "relay-user-1-99",
      userId: "user-1",
      installationId: "99",
      state: "suspended",
      generation: 1
    })

    value.setInstallations([])
    const uninstalled = await value.routes.request("/refresh", {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(await uninstalled.json()).toMatchObject({
      connected: true,
      installations: []
    })
    expect(value.getRelayRegistrations()).toContainEqual({
      mutationId: "relay-user-1-99",
      userId: "user-1",
      installationId: "99",
      state: "removed",
      generation: 1
    })
  })

  it("returns immutable selected repository identities and reconciles selection changes", async () => {
    const value = harness()
    value.setInstallations([githubInstallation({ repositorySelection: "selected" })])
    expect((await connect(value)).status).toBe(302)

    const selected = await value.routes.request("/status", {
      headers: asUser("user-1")
    })
    expect(await selected.json()).toMatchObject({
      installations: [
        {
          id: "99",
          repositorySelection: "selected",
          repositories: [{ id: "301", fullName: "acme/widget" }]
        }
      ]
    })

    value.setRepositories([{ id: "302", fullName: "acme/other" }])
    const refreshed = await value.routes.request("/refresh", {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(await refreshed.json()).toMatchObject({
      installations: [
        {
          id: "99",
          repositories: [{ id: "302", fullName: "acme/other" }]
        }
      ]
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
    const grantBody = (await grantResponse.json()) as {
      readonly grant: string
    }
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
    expect(value.getRelayRegistrations()).toContainEqual({
      mutationId: "relay-user-1-99",
      userId: "user-1",
      installationId: "99",
      state: "removed",
      generation: 1
    })
    expect(value.authorizations.has("user-1")).toBe(false)
    const status = await value.routes.request("/status", {
      headers: asUser("user-1")
    })
    expect(await status.json()).toMatchObject({
      connected: false,
      installations: []
    })
  })

  it("deletes local authorization before retrying an unavailable relay revocation", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    value.setRelayAvailable(false)

    const disconnected = await value.routes.request("/disconnect", {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(disconnected.status).toBe(204)
    expect(value.authorizations.has("user-1")).toBe(false)
    expect(value.getPendingRelayMutations()).toBe(1)

    value.setRelayAvailable(true)
    const status = await value.routes.request("/status", {
      headers: asUser("user-1")
    })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ connected: false })
    expect(value.getPendingRelayMutations()).toBe(0)
    expect(value.getRelayRegistrations()).toContainEqual({
      mutationId: "relay-user-1-99",
      userId: "user-1",
      installationId: "99",
      state: "removed",
      generation: 1
    })
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

  it("deduplicates stale reconciliation across concurrent credential requests", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    value.setNow(new Date("2026-08-04T10:01:01Z"))
    const saveCount = value.getSaveCount()
    const request = () =>
      value.routes.request("/installation-credentials", {
        method: "POST",
        headers: { ...asUser("user-1"), "content-type": "application/json" },
        body: JSON.stringify({
          installationId: "99",
          scopes: ["pull_requests:read", "repository:acme/widgets"]
        })
      })

    const responses = await Promise.all(Array.from({ length: 8 }, request))

    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(value.getSaveCount()).toBe(saveCount + 1)
  })

  it("creates pull requests with the connected user token after verifying repository access", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)

    const response = await value.routes.request("/pull-requests", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        installationId: "99",
        repository: "acme/widget",
        title: "Fix publishing",
        body: "PR body",
        head: "acme:chore/fix-publishing",
        base: "main",
        draft: false
      })
    })

    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ number: 1731 })
    expect(value.getCreatedPullRequests()).toEqual([
      {
        accessToken: "ghu_user-secret",
        repository: "acme/widget",
        head: "acme:chore/fix-publishing",
        base: "main"
      }
    ])
    expect(value.getMintedInstallations()).toEqual([])
  })

  it("rejects pull request creation outside the selected installation repositories", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)

    const response = await value.routes.request("/pull-requests", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        installationId: "99",
        repository: "acme/other",
        title: "Not allowed",
        body: "",
        head: "acme:chore/not-allowed",
        base: "main",
        draft: false
      })
    })

    expect(response.status).toBe(403)
    expect(value.getCreatedPullRequests()).toEqual([])
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

    value.setInstallations([githubInstallation({ suspendedAt: new Date("2026-08-04T10:05:00Z") })])
    const suspended = await value.routes.request("/installation-credentials", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({ installationId: "99" })
    })
    expect(suspended.status).toBe(403)
    expect(value.getMintedInstallations()).toEqual([])
  })

  it("registers an authenticated session route and mints a grant scoped to its opaque id", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const linked = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-1",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    })
    expect(linked.status).toBe(200)
    const body = (await linked.json()) as {
      route: { relaySessionId: string; sessionId: string; state: string }
    }
    expect(body.route).toMatchObject({
      sessionId: "local-session-1",
      state: "active"
    })
    expect(value.getSessionRelayRegistrations()).toContainEqual(
      expect.objectContaining({
        state: "active",
        userId: "user-1",
        relaySessionId: body.route.relaySessionId,
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    )
    expect(JSON.stringify(value.getSessionRelayRegistrations())).not.toContain("local-session-1")

    const grant = await value.routes.request("/session-grant", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({ relaySessionId: body.route.relaySessionId })
    })
    expect(grant.status).toBe(200)
    expect(await grant.json()).toMatchObject({
      claims: {
        subject: "user-1",
        installationId: "99",
        relaySessionId: body.route.relaySessionId
      }
    })
  })

  it("rejects cross-user session grants and unavailable repositories", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const linked = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-1",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    })
    const relaySessionId = ((await linked.json()) as { route: { relaySessionId: string } }).route
      .relaySessionId
    expect(
      (
        await value.routes.request("/session-grant", {
          method: "POST",
          headers: { ...asUser("user-2"), "content-type": "application/json" },
          body: JSON.stringify({ relaySessionId })
        })
      ).status
    ).toBe(403)

    const unavailable = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-2",
        installationId: "99",
        repositoryId: "999",
        pullRequestNumber: 43
      })
    })
    expect(unavailable.status).toBe(403)

    value.setRepositories([{ id: "302", fullName: "acme/other" }])
    value.setNow(new Date("2026-08-04T10:01:01Z"))
    const revokedGrant = await value.routes.request("/session-grant", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({ relaySessionId })
    })
    expect(revokedGrant.status).toBe(403)
    expect(value.getSessionRelayRegistrations()).toContainEqual(
      expect.objectContaining({ relaySessionId, state: "removed" })
    )
  })

  it("removes the old tuple before activating a changed session route identity", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const first = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-1",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    })
    const relaySessionId = ((await first.json()) as { route: { relaySessionId: string } }).route
      .relaySessionId
    value.setRepositories([
      { id: "301", fullName: "acme/widget" },
      { id: "302", fullName: "acme/other" }
    ])
    const changed = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-1",
        installationId: "99",
        repositoryId: "302",
        pullRequestNumber: 43
      })
    })
    expect(changed.status).toBe(200)
    const changedBody = (await changed.json()) as {
      route: { relaySessionId: string }
    }
    expect(changedBody.route.relaySessionId).not.toBe(relaySessionId)
    expect(value.getSessionRelayRegistrations().slice(-2)).toEqual([
      expect.objectContaining({
        relaySessionId,
        repositoryId: "301",
        pullRequestNumber: 42,
        state: "removed",
        generation: 2
      }),
      expect.objectContaining({
        relaySessionId: changedBody.route.relaySessionId,
        repositoryId: "302",
        pullRequestNumber: 43,
        state: "active",
        generation: 3
      })
    ])
  })

  it("allows a removed pull request tuple to be linked to another session", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const first = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-1",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    })
    const relaySessionId = ((await first.json()) as { route: { relaySessionId: string } }).route
      .relaySessionId
    expect(
      (
        await value.routes.request(`/session-routes/${relaySessionId}/unlink`, {
          method: "POST",
          headers: asUser("user-1")
        })
      ).status
    ).toBe(204)
    const relinked = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-2",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    })
    expect(relinked.status).toBe(200)
    expect(await relinked.json()).toMatchObject({
      route: { sessionId: "local-session-2" }
    })
  })

  it("retains a session route mutation until relay Workflow creation recovers", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    value.setRelayAvailable(false)
    const linked = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-1",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    })
    expect(linked.status).toBe(200)
    expect(value.getPendingSessionMutations()).toBe(1)

    value.setRelayAvailable(true)
    const listed = await value.routes.request("/session-routes", {
      headers: asUser("user-1")
    })
    expect(listed.status).toBe(200)
    expect(value.getPendingSessionMutations()).toBe(0)
    expect(value.getSessionRelayRegistrations()).toHaveLength(1)
  })

  it("archives and unlinks only the authenticated user's session route", async () => {
    const value = harness()
    expect((await connect(value)).status).toBe(302)
    const linked = await value.routes.request("/session-routes", {
      method: "POST",
      headers: { ...asUser("user-1"), "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "local-session-1",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42
      })
    })
    const relaySessionId = ((await linked.json()) as { route: { relaySessionId: string } }).route
      .relaySessionId
    expect(
      (
        await value.routes.request(`/session-routes/${relaySessionId}/archive`, {
          method: "POST",
          headers: asUser("user-2")
        })
      ).status
    ).toBe(404)
    const archived = await value.routes.request(`/session-routes/${relaySessionId}/archive`, {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(archived.status).toBe(200)
    expect(await archived.json()).toMatchObject({
      route: { state: "archived" }
    })
    const removed = await value.routes.request(`/session-routes/${relaySessionId}/unlink`, {
      method: "POST",
      headers: asUser("user-1")
    })
    expect(removed.status).toBe(204)
    expect(value.getSessionRelayRegistrations()).toContainEqual(
      expect.objectContaining({ relaySessionId, state: "removed" })
    )
  })
})
