/** Authenticated HTTP surface for the shared GitHub App product connection. */
import type {
  GitHubAppConnectionStatus,
  GitHubAppInstallation as GitHubAppInstallationView
} from "@jingler/core"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { Option } from "effect"
import { Hono } from "hono"
import { getAuth } from "./auth.js"
import {
  GitHubConnectionRepository,
  type GitHubAuthorizationRecord,
  type GitHubCallbackStateKind,
  type GitHubCallbackStateRecord,
  type GitHubInstallationRecord,
  type SaveGitHubConnectionInput
} from "./db/repositories/github-connection-repository.js"
import { env } from "./env.js"
import {
  createGitHubAppClient,
  createGitHubPkce,
  createGitHubTokenCipher,
  hashGitHubCallbackState,
  type GitHubApiInstallation,
  type GitHubAppClient,
  type GitHubTokenCipher,
  type GitHubUserToken
} from "./github-app.js"
import { issueGitHubRelayGrant } from "./github-relay-grant.js"
import { runtime } from "./runtime.js"

const STATE_TTL_MS = 10 * 60 * 1_000
const TOKEN_REFRESH_SKEW_MS = 60 * 1_000

export interface GitHubConnectionStore {
  readonly createCallbackState: (input: {
    readonly id: string
    readonly stateHash: string
    readonly userId: string
    readonly kind: GitHubCallbackStateKind
    readonly redirectUri: string
    readonly codeVerifierEncrypted: string
    readonly expiresAt: Date
    readonly createdAt: Date
  }) => Promise<void>
  readonly consumeCallbackState: (input: {
    readonly stateHash: string
    readonly userId: string
    readonly kinds: ReadonlyArray<GitHubCallbackStateKind>
    readonly at: Date
  }) => Promise<GitHubCallbackStateRecord | null>
  readonly findAuthorizationByUserId: (userId: string) => Promise<GitHubAuthorizationRecord | null>
  readonly listInstallationsByAuthorizationId: (
    authorizationId: string
  ) => Promise<ReadonlyArray<GitHubInstallationRecord>>
  readonly findInstallationForUser: (
    userId: string,
    installationId: string
  ) => Promise<GitHubInstallationRecord | null>
  readonly saveConnection: (input: SaveGitHubConnectionInput) => Promise<GitHubAuthorizationRecord>
  readonly replaceInstallations: (input: {
    readonly authorizationId: string
    readonly installations: SaveGitHubConnectionInput["installations"]
    readonly refreshedAt: Date
  }) => Promise<void>
  readonly updateTokens: (input: {
    readonly userId: string
    readonly accessTokenEncrypted: string
    readonly refreshTokenEncrypted: string | null
    readonly accessTokenExpiresAt: Date | null
    readonly refreshTokenExpiresAt: Date | null
    readonly updatedAt: Date
  }) => Promise<void>
  readonly disconnect: (userId: string) => Promise<void>
}

export interface GitHubRoutesDependencies {
  readonly enabled: boolean
  readonly configured: boolean
  readonly desktopRedirect: string
  readonly relayUrl: string
  readonly relaySigningSecret: string
  readonly getUserId: (headers: Headers) => Promise<string | null>
  readonly github: GitHubAppClient
  readonly cipher: GitHubTokenCipher
  readonly store: GitHubConnectionStore
  readonly revokeRelaySubscription?: (input: {
    readonly userId: string
    readonly installationId: string
    readonly reason: "disconnect" | "uninstall" | "suspension"
  }) => Promise<void>
  readonly now?: () => Date
  readonly randomState?: () => string
  readonly randomId?: () => string
}

const repositoryStore: GitHubConnectionStore = {
  createCallbackState: async (input) => {
    await runtime.runPromise(GitHubConnectionRepository.createCallbackState(input))
  },
  consumeCallbackState: async (input) =>
    Option.getOrNull(
      await runtime.runPromise(GitHubConnectionRepository.consumeCallbackState(input))
    ),
  findAuthorizationByUserId: async (userId) =>
    Option.getOrNull(
      await runtime.runPromise(GitHubConnectionRepository.findAuthorizationByUserId(userId))
    ),
  listInstallationsByAuthorizationId: (authorizationId) =>
    runtime.runPromise(
      GitHubConnectionRepository.listInstallationsByAuthorizationId(authorizationId)
    ),
  findInstallationForUser: async (userId, installationId) =>
    Option.getOrNull(
      await runtime.runPromise(
        GitHubConnectionRepository.findInstallationForUser(userId, installationId)
      )
    ),
  saveConnection: (input) => runtime.runPromise(GitHubConnectionRepository.saveConnection(input)),
  replaceInstallations: async (input) => {
    await runtime.runPromise(GitHubConnectionRepository.replaceInstallations(input))
  },
  updateTokens: async (input) => {
    await runtime.runPromise(GitHubConnectionRepository.updateTokens(input))
  },
  disconnect: async (userId) => {
    await runtime.runPromise(GitHubConnectionRepository.disconnect(userId))
  }
}

const revokeRelaySubscription = async (
  relayUrl: string,
  secret: string,
  input: {
    readonly userId: string
    readonly installationId: string
    readonly reason: "disconnect" | "uninstall" | "suspension"
  }
): Promise<void> => {
  const body = JSON.stringify(input)
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")
  const response = await fetch(new URL("/internal/revoke", relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jingler-timestamp": timestamp,
      "x-jingler-signature": `sha256=${signature}`
    },
    body
  })
  if (!response.ok) throw new Error("GitHub relay revocation failed")
}

let cachedClient: GitHubAppClient | undefined
let cachedCipher: GitHubTokenCipher | undefined

const defaultDependencies = (): GitHubRoutesDependencies => {
  const config = {
    appId: env.githubAppId,
    clientId: env.githubAppClientId,
    clientSecret: env.githubAppClientSecret,
    privateKey: env.githubAppPrivateKey,
    relayUrl: env.githubAppRelayUrl,
    relaySigningSecret: env.githubAppRelaySigningSecret
  }
  cachedClient ??= createGitHubAppClient(config)
  cachedCipher ??= createGitHubTokenCipher(config.relaySigningSecret)
  return {
    enabled: env.githubAppEnabled,
    configured: env.githubAppConfigured,
    desktopRedirect: env.desktopRedirect,
    relayUrl: config.relayUrl,
    relaySigningSecret: config.relaySigningSecret,
    getUserId: async (headers) => {
      const session = await getAuth().api.getSession({ headers }).catch(() => null)
      return session?.user.id ?? null
    },
    github: cachedClient,
    cipher: cachedCipher,
    store: repositoryStore,
    revokeRelaySubscription: (input) =>
      revokeRelaySubscription(config.relayUrl, config.relaySigningSecret, input)
  }
}

/** Shared open-redirect guard for auth and GitHub App desktop callbacks. */
export const isLoopbackRedirect = (raw: string): boolean => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== "http:") return false
  return (
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
  )
}

/** Append callback state while preserving the desktop loopback listener's nonce. */
export const withQuery = (raw: string, values: Readonly<Record<string, string>>): string => {
  const url = new URL(raw)
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url.toString()
}

const noStore = { "cache-control": "no-store" } as const

const toInstallationInput = (
  installation: GitHubApiInstallation
): SaveGitHubConnectionInput["installations"][number] => ({
  installationId: installation.id,
  accountId: installation.account.id,
  accountLogin: installation.account.login,
  accountType: installation.account.type,
  accountAvatarUrl: installation.account.avatarUrl,
  repositorySelection: installation.repositorySelection,
  permissions: installation.permissions,
  suspendedAt: installation.suspendedAt
})

const toInstallationView = (
  installation: GitHubInstallationRecord
): GitHubAppInstallationView => ({
  id: installation.installationId,
  account: {
    id: installation.accountId,
    login: installation.accountLogin,
    type: installation.accountType,
    avatarUrl: installation.accountAvatarUrl
  },
  repositorySelection: installation.repositorySelection,
  permissions: { ...installation.permissions },
  status: installation.suspendedAt ? "suspended" : "active",
  suspendedAt: installation.suspendedAt?.toISOString() ?? null
})

const statusFor = async (
  dependencies: GitHubRoutesDependencies,
  userId: string
): Promise<GitHubAppConnectionStatus> => {
  const authorization = await dependencies.store.findAuthorizationByUserId(userId)
  if (!authorization) {
    return {
      enabled: dependencies.enabled && dependencies.configured,
      connected: false,
      user: null,
      installations: [],
      lastRefreshedAt: null
    }
  }
  const installations = await dependencies.store.listInstallationsByAuthorizationId(
    authorization.id
  )
  return {
    enabled: dependencies.enabled && dependencies.configured,
    connected: true,
    user: {
      id: authorization.githubUserId,
      login: authorization.githubLogin,
      name: authorization.githubName,
      avatarUrl: authorization.githubAvatarUrl
    },
    installations: installations.map(toInstallationView),
    lastRefreshedAt: authorization.lastRefreshedAt.toISOString()
  }
}

const encryptedTokenFields = (
  token: GitHubUserToken,
  cipher: GitHubTokenCipher
): Pick<
  GitHubAuthorizationRecord,
  | "accessTokenEncrypted"
  | "refreshTokenEncrypted"
  | "accessTokenExpiresAt"
  | "refreshTokenExpiresAt"
> => ({
  accessTokenEncrypted: cipher.encrypt(token.accessToken),
  refreshTokenEncrypted: token.refreshToken ? cipher.encrypt(token.refreshToken) : null,
  accessTokenExpiresAt: token.accessTokenExpiresAt,
  refreshTokenExpiresAt: token.refreshTokenExpiresAt
})

const activeUserToken = async (
  dependencies: GitHubRoutesDependencies,
  authorization: GitHubAuthorizationRecord
): Promise<{
  readonly accessToken: string
  readonly fields: Pick<
    GitHubAuthorizationRecord,
    | "accessTokenEncrypted"
    | "refreshTokenEncrypted"
    | "accessTokenExpiresAt"
    | "refreshTokenExpiresAt"
  >
}> => {
  const now = (dependencies.now ?? (() => new Date()))()
  const needsRefresh =
    authorization.accessTokenExpiresAt !== null &&
    authorization.accessTokenExpiresAt.getTime() <= now.getTime() + TOKEN_REFRESH_SKEW_MS
  if (!needsRefresh) {
    return {
      accessToken: dependencies.cipher.decrypt(authorization.accessTokenEncrypted),
      fields: authorization
    }
  }
  if (
    !authorization.refreshTokenEncrypted ||
    (authorization.refreshTokenExpiresAt !== null && authorization.refreshTokenExpiresAt <= now)
  ) {
    throw new Error("GitHub authorization must be renewed")
  }
  const refreshed = await dependencies.github.refreshUserToken(
    dependencies.cipher.decrypt(authorization.refreshTokenEncrypted)
  )
  const fields = encryptedTokenFields(refreshed, dependencies.cipher)
  await dependencies.store.updateTokens({
    userId: authorization.userId,
    ...fields,
    updatedAt: now
  })
  return { accessToken: refreshed.accessToken, fields }
}

/** Reconcile identity and installations from GitHub's user-authorized view. */
const reconcile = async (
  dependencies: GitHubRoutesDependencies,
  userId: string
): Promise<GitHubAuthorizationRecord | null> => {
  const authorization = await dependencies.store.findAuthorizationByUserId(userId)
  if (!authorization) return null
  const previousInstallations = await dependencies.store.listInstallationsByAuthorizationId(
    authorization.id
  )
  const token = await activeUserToken(dependencies, authorization)
  const [githubUser, installations] = await Promise.all([
    dependencies.github.getUser(token.accessToken),
    dependencies.github.listInstallations(token.accessToken)
  ])
  const refreshedAt = (dependencies.now ?? (() => new Date()))()
  const currentById = new Map(installations.map((installation) => [installation.id, installation]))
  // Revoke before replacing installation rows so a relay outage leaves the
  // prior lifecycle state available for a deterministic reconciliation retry.
  await Promise.all(
    previousInstallations.flatMap((previous) => {
      const current = currentById.get(previous.installationId)
      const reason = !current ? "uninstall" : current.suspendedAt ? "suspension" : null
      return reason && dependencies.revokeRelaySubscription
        ? [
            dependencies.revokeRelaySubscription({
              userId,
              installationId: previous.installationId,
              reason
            })
          ]
        : []
    })
  )
  return dependencies.store.saveConnection({
    authorization: {
      id: authorization.id,
      userId,
      githubUserId: githubUser.id,
      githubLogin: githubUser.login,
      githubName: githubUser.name,
      githubAvatarUrl: githubUser.avatarUrl,
      ...token.fields
    },
    installations: installations.map(toInstallationInput),
    refreshedAt
  })
}

const parseInstallationId = (raw: string | undefined): string | null =>
  raw && /^\d+$/.test(raw) ? raw : null

const INSTALLATION_TOKEN_PERMISSION_ALLOWLIST: Readonly<
  Record<string, ReadonlySet<"read" | "write">>
> = {
  checks: new Set(["read"]),
  contents: new Set(["read", "write"]),
  issues: new Set(["read", "write"]),
  pull_requests: new Set(["read", "write"]),
  statuses: new Set(["read", "write"]),
  workflows: new Set(["read", "write"])
}

const installationTokenScope = (
  scopes: ReadonlyArray<string>,
  installation: GitHubInstallationRecord
): {
  readonly permissions: Readonly<Record<string, "read" | "write">>
  readonly repositories: ReadonlyArray<string>
} | null => {
  const permissions: Record<string, "read" | "write"> = {}
  const repositories: string[] = []
  for (const scope of [...new Set(scopes)]) {
    if (scope.startsWith("repository:")) {
      const qualified = scope.slice("repository:".length)
      const [owner, name, extra] = qualified.split("/")
      if (
        !owner ||
        !name ||
        extra !== undefined ||
        owner.toLowerCase() !== installation.accountLogin.toLowerCase()
      ) {
        return null
      }
      repositories.push(name)
      continue
    }
    const match = /^([a-z][a-z0-9_]*):(read|write)$/.exec(scope)
    if (!match?.[1] || (match[2] !== "read" && match[2] !== "write")) return null
    const permission = match[1]
    const requested = match[2]
    // Metadata is implicit and cannot narrow an installation token. Accepting
    // it here would turn a metadata-only request into an omitted permissions
    // object, which GitHub interprets as every permission on the installation.
    const allowed = INSTALLATION_TOKEN_PERMISSION_ALLOWLIST[permission]
    if (!allowed?.has(requested)) return null
    const installed = installation.permissions[permission]
    if (installed !== "write" && !(installed === "read" && requested === "read")) return null
    permissions[permission] = requested
  }
  // Built-in credentials are always for exactly one repository and at least
  // one explicit, narrowable permission. Never call GitHub with `{}`: that
  // mints the installation's full repository and permission scope.
  if (repositories.length !== 1 || Object.keys(permissions).length === 0) return null
  return { permissions, repositories }
}

const callbackError = (): Response =>
  Response.json({ error: "GitHub callback rejected" }, { status: 400, headers: noStore })

export const createGitHubRoutes = (
  resolveDependencies: () => GitHubRoutesDependencies = defaultDependencies
): Hono => {
  const routes = new Hono()

  const authenticated = async (
    headers: Headers,
    dependencies: GitHubRoutesDependencies
  ): Promise<string | null> => dependencies.getUserId(headers)

  const available = (dependencies: GitHubRoutesDependencies): boolean =>
    dependencies.enabled && dependencies.configured

  const start = async (
    request: Request,
    kind: GitHubCallbackStateKind
  ): Promise<Response> => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(request.headers, dependencies)
    if (!userId) {
      return Response.json({ error: "Authentication required" }, { status: 401, headers: noStore })
    }
    if (!available(dependencies)) {
      return Response.json(
        { error: "GitHub App is not configured" },
        { status: 503, headers: noStore }
      )
    }
    const requestUrl = new URL(request.url)
    const requestedRedirect = requestUrl.searchParams.get("redirect")
    const redirectUri =
      requestedRedirect && isLoopbackRedirect(requestedRedirect)
        ? requestedRedirect
        : dependencies.desktopRedirect
    const state = (dependencies.randomState ?? (() => randomBytes(32).toString("base64url")))()
    const pkce = createGitHubPkce()
    const now = (dependencies.now ?? (() => new Date()))()
    const expiresAt = new Date(now.getTime() + STATE_TTL_MS)
    await dependencies.store.createCallbackState({
      id: (dependencies.randomId ?? randomUUID)(),
      stateHash: hashGitHubCallbackState(state),
      userId,
      kind,
      redirectUri,
      codeVerifierEncrypted: dependencies.cipher.encrypt(pkce.verifier),
      expiresAt,
      createdAt: now
    })
    const url =
      kind === "authorize"
        ? dependencies.github.authorizationUrl(state, pkce.challenge)
        : await dependencies.github.installationUrl(state)
    return Response.json({ url, expiresAt: expiresAt.toISOString() }, { headers: noStore })
  }

  const finishOAuth = async (request: Request): Promise<Response> => {
    const dependencies = resolveDependencies()
    if (!available(dependencies)) return callbackError()
    const userId = await authenticated(request.headers, dependencies)
    if (!userId) return callbackError()
    const url = new URL(request.url)
    const state = url.searchParams.get("state")
    const code = url.searchParams.get("code")
    if (!state) return callbackError()
    const now = (dependencies.now ?? (() => new Date()))()
    const callbackState = await dependencies.store.consumeCallbackState({
      stateHash: hashGitHubCallbackState(state),
      userId,
      kinds: ["authorize", "install"],
      at: now
    })
    if (!callbackState) return callbackError()
    if (!code || url.searchParams.has("error")) return callbackError()
    try {
      const token = await dependencies.github.exchangeCode(
        code,
        callbackState.kind === "authorize"
          ? dependencies.cipher.decrypt(callbackState.codeVerifierEncrypted)
          : undefined
      )
      const [githubUser, installations] = await Promise.all([
        dependencies.github.getUser(token.accessToken),
        dependencies.github.listInstallations(token.accessToken)
      ])
      const requestedInstallation = parseInstallationId(
        url.searchParams.get("installation_id") ?? undefined
      )
      if (
        requestedInstallation &&
        !installations.some((installation) => installation.id === requestedInstallation)
      ) {
        return callbackError()
      }
      await dependencies.store.saveConnection({
        authorization: {
          id: (dependencies.randomId ?? randomUUID)(),
          userId,
          githubUserId: githubUser.id,
          githubLogin: githubUser.login,
          githubName: githubUser.name,
          githubAvatarUrl: githubUser.avatarUrl,
          ...encryptedTokenFields(token, dependencies.cipher)
        },
        installations: installations.map(toInstallationInput),
        refreshedAt: now
      })
      return Response.redirect(
        withQuery(callbackState.redirectUri, { github: "connected" }),
        302
      )
    } catch {
      return callbackError()
    }
  }

  const finishSetup = async (request: Request): Promise<Response> => {
    const dependencies = resolveDependencies()
    if (!available(dependencies)) return callbackError()
    const userId = await authenticated(request.headers, dependencies)
    if (!userId) return callbackError()
    const url = new URL(request.url)
    const state = url.searchParams.get("state")
    const installationId = parseInstallationId(
      url.searchParams.get("installation_id") ?? undefined
    )
    if (!state || !installationId) return callbackError()
    const now = (dependencies.now ?? (() => new Date()))()
    const callbackState = await dependencies.store.consumeCallbackState({
      stateHash: hashGitHubCallbackState(state),
      userId,
      kinds: ["install"],
      at: now
    })
    if (!callbackState) return callbackError()
    try {
      await reconcile(dependencies, userId)
      const installation = await dependencies.store.findInstallationForUser(userId, installationId)
      if (!installation) return callbackError()
      return Response.redirect(
        withQuery(callbackState.redirectUri, { github: "connected" }),
        302
      )
    } catch {
      return callbackError()
    }
  }

  routes.get("/status", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json(
        {
          enabled: false,
          connected: false,
          user: null,
          installations: [],
          lastRefreshedAt: null
        } satisfies GitHubAppConnectionStatus,
        200,
        noStore
      )
    }
    try {
      await reconcile(dependencies, userId)
      return c.json(await statusFor(dependencies, userId), 200, noStore)
    } catch {
      return c.json({ error: "GitHub refresh failed" }, 502, noStore)
    }
  })

  const install = (c: { readonly req: { readonly raw: Request } }): Promise<Response> =>
    start(c.req.raw, "install")
  routes.get("/install", install)
  routes.post("/install", install)
  routes.get("/install-url", install)
  routes.post("/install-url", install)

  const authorize = (c: { readonly req: { readonly raw: Request } }): Promise<Response> =>
    start(c.req.raw, "authorize")
  routes.get("/authorize", authorize)
  routes.post("/authorize", authorize)

  routes.get("/callback", (c) => finishOAuth(c.req.raw))
  routes.get("/callback/oauth", (c) => finishOAuth(c.req.raw))
  routes.get("/setup", (c) => finishSetup(c.req.raw))
  routes.get("/callback/install", (c) => finishSetup(c.req.raw))

  routes.post("/refresh", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json({ error: "GitHub App is not configured" }, 503, noStore)
    }
    try {
      await reconcile(dependencies, userId)
      return c.json(await statusFor(dependencies, userId), 200, noStore)
    } catch {
      return c.json({ error: "GitHub refresh failed" }, 502, noStore)
    }
  })

  routes.post("/disconnect", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json({ error: "GitHub App is not configured" }, 503, noStore)
    }
    const authorization = await dependencies.store.findAuthorizationByUserId(userId)
    const installations = authorization
      ? await dependencies.store.listInstallationsByAuthorizationId(authorization.id)
      : []
    if (authorization) {
      try {
        await dependencies.github.revokeUserToken(
          dependencies.cipher.decrypt(authorization.accessTokenEncrypted)
        )
      } catch {
        // Local revocation is authoritative for Jingler; remote revocation is best-effort.
      }
    }
    if (dependencies.revokeRelaySubscription) {
      await Promise.all(
        installations.map((installation) =>
          dependencies.revokeRelaySubscription!({
            userId,
            installationId: installation.installationId,
            reason: "disconnect"
          })
        )
      )
    }
    await dependencies.store.disconnect(userId)
    return c.body(null, 204, noStore)
  })

  routes.post("/desktop-grant", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json({ error: "GitHub App is not configured" }, 503, noStore)
    }
    let installationId: string | null = null
    try {
      const body: unknown = await c.req.json()
      if (body && typeof body === "object" && !Array.isArray(body)) {
        installationId = parseInstallationId(
          typeof (body as Record<string, unknown>).installationId === "string"
            ? String((body as Record<string, unknown>).installationId)
            : undefined
        )
      }
    } catch {
      installationId = null
    }
    if (!installationId) return c.json({ error: "installationId is required" }, 400, noStore)
    try {
      await reconcile(dependencies, userId)
      const installation = await dependencies.store.findInstallationForUser(userId, installationId)
      if (!installation || installation.suspendedAt) {
        return c.json({ error: "Active installation required" }, 403, noStore)
      }
      const nowSeconds = Math.floor((dependencies.now ?? (() => new Date()))().getTime() / 1_000)
      return c.json(
        issueGitHubRelayGrant(
          { userId, installationId },
          {
            relayUrl: dependencies.relayUrl,
            relaySigningSecret: dependencies.relaySigningSecret
          },
          nowSeconds,
          (dependencies.randomId ?? (() => randomUUID()))()
        ),
        200,
        noStore
      )
    } catch {
      return c.json({ error: "GitHub grant failed" }, 502, noStore)
    }
  })

  /**
   * Trusted Electron-main credential boundary. The installation token is minted
   * on demand, explicitly marked non-cacheable, and never reaches persistence.
   */
  routes.post("/installation-credentials", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json({ error: "GitHub App is not configured" }, 503, noStore)
    }
    let installationId: string | null = null
    let scopes: ReadonlyArray<string> | null = []
    try {
      const body: unknown = await c.req.json()
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>
        installationId = parseInstallationId(
          typeof record.installationId === "string"
            ? record.installationId
            : undefined
        )
        scopes =
          record.scopes === undefined
            ? []
            : Array.isArray(record.scopes) && record.scopes.every((scope) => typeof scope === "string")
              ? record.scopes
              : null
      }
    } catch {
      installationId = null
      scopes = null
    }
    if (!installationId || scopes === null) {
      return c.json({ error: "installationId and valid scopes are required" }, 400, noStore)
    }
    try {
      await reconcile(dependencies, userId)
      const installation = await dependencies.store.findInstallationForUser(userId, installationId)
      if (!installation || installation.suspendedAt) {
        return c.json({ error: "Active installation required" }, 403, noStore)
      }
      const scope = installationTokenScope(scopes, installation)
      if (!scope) return c.json({ error: "Requested GitHub scopes are not available" }, 403, noStore)
      const credential = await dependencies.github.createInstallationAccessToken(
        installationId,
        scope
      )
      return c.json(
        {
          token: credential.token,
          expiresAt: credential.expiresAt.toISOString(),
          installationId
        },
        200,
        noStore
      )
    } catch {
      return c.json({ error: "GitHub credential minting failed" }, 502, noStore)
    }
  })

  return routes
}

export { createGitHubRoutes as createGithubRoutes }
