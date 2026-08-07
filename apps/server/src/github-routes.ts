/** Authenticated HTTP surface for the shared GitHub App product connection. */
import type {
  GitHubAppConnectionStatus,
  GitHubAppInstallation as GitHubAppInstallationView,
  GitHubSessionRoute
} from "@jingler/core"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { Option } from "effect"
import { Hono, type Context } from "hono"
import { getAuth } from "./auth.js"
import {
  GitHubConnectionRepository,
  type GitHubAuthorizationRecord,
  type GitHubCallbackStateKind,
  type GitHubCallbackStateRecord,
  type GitHubInstallationRecord,
  type GitHubRelayRegistrationMutation,
  type GitHubRelayRegistrationState,
  type SaveGitHubConnectionInput
} from "./db/repositories/github-connection-repository.js"
import {
  GitHubSessionRouteRepository,
  type GitHubSessionRouteMutation,
  type GitHubSessionRouteRecord
} from "./db/repositories/github-session-route-repository.js"
import { env } from "./env.js"
import {
  createGitHubAppClient,
  createGitHubPkce,
  createGitHubTokenCipher,
  hashGitHubCallbackState,
  type GitHubApiInstallation,
  type GitHubApiRepository,
  type GitHubAppClient,
  GitHubAppError,
  type GitHubTokenCipher,
  type GitHubUserToken
} from "./github-app.js"
import { issueGitHubRelayGrant, issueGitHubSessionRelayGrant } from "./github-relay-grant.js"
import { runtime } from "./runtime.js"

const STATE_TTL_MS = 10 * 60 * 1_000
const TOKEN_REFRESH_SKEW_MS = 60 * 1_000
const RECONCILE_TTL_MS = 60 * 1_000
const STATUS_CACHE_TTL_MS = 15 * 1_000

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
  readonly listPendingRelayMutations: (
    at: Date,
    limit?: number
  ) => Promise<ReadonlyArray<GitHubRelayRegistrationMutation>>
  readonly markRelayMutationDelivered: (id: string, deliveredAt: Date) => Promise<void>
  readonly markRelayMutationFailed: (input: {
    readonly id: string
    readonly retryAt: Date
    readonly updatedAt: Date
    readonly error: string
  }) => Promise<void>
}

export interface GitHubSessionRouteStore {
  readonly listByUserId: (userId: string) => Promise<ReadonlyArray<GitHubSessionRouteRecord>>
  readonly findForUser: (
    userId: string,
    relaySessionId: string
  ) => Promise<GitHubSessionRouteRecord | null>
  readonly upsertActive: (input: {
    readonly userId: string
    readonly sessionId: string
    readonly relaySessionId: string
    readonly installationId: string
    readonly repositoryId: string
    readonly pullRequestNumber: number
    readonly at: Date
  }) => Promise<GitHubSessionRouteRecord>
  readonly setState: (input: {
    readonly userId: string
    readonly relaySessionId: string
    readonly state: "archived" | "removed"
    readonly at: Date
  }) => Promise<GitHubSessionRouteRecord | null>
  readonly removeAllForUser: (userId: string, at: Date) => Promise<void>
  readonly listPendingMutations: (
    at: Date,
    limit?: number
  ) => Promise<ReadonlyArray<GitHubSessionRouteMutation>>
  readonly markMutationDelivered: (id: string, deliveredAt: Date) => Promise<void>
  readonly markMutationFailed: (input: {
    readonly id: string
    readonly retryAt: Date
    readonly updatedAt: Date
    readonly error: string
  }) => Promise<void>
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
  readonly sessionRoutes: GitHubSessionRouteStore
  readonly syncRelayRegistration?: (input: {
    readonly mutationId: string
    readonly userId: string
    readonly installationId: string
    readonly state: GitHubRelayRegistrationState
    readonly generation: number
  }) => Promise<void>
  readonly syncRelaySessionRoute?: (input: {
    readonly mutationId: string
    readonly state: "active" | "archived" | "removed"
    readonly userId: string
    readonly relaySessionId: string
    readonly installationId: string
    readonly repositoryId: string
    readonly pullRequestNumber: number
    readonly generation: number
  }) => Promise<void>
  readonly now?: () => Date
  readonly randomState?: () => string
  readonly randomId?: () => string
  readonly randomRelaySessionId?: () => string
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
  },
  listPendingRelayMutations: (at, limit) =>
    runtime.runPromise(GitHubConnectionRepository.listPendingRelayMutations(at, limit)),
  markRelayMutationDelivered: async (id, deliveredAt) => {
    await runtime.runPromise(GitHubConnectionRepository.markRelayMutationDelivered(id, deliveredAt))
  },
  markRelayMutationFailed: async (input) => {
    await runtime.runPromise(GitHubConnectionRepository.markRelayMutationFailed(input))
  }
}

const sessionRouteStore: GitHubSessionRouteStore = {
  listByUserId: (userId) => runtime.runPromise(GitHubSessionRouteRepository.listByUserId(userId)),
  findForUser: async (userId, relaySessionId) =>
    Option.getOrNull(
      await runtime.runPromise(GitHubSessionRouteRepository.findForUser(userId, relaySessionId))
    ),
  upsertActive: (input) => runtime.runPromise(GitHubSessionRouteRepository.upsertActive(input)),
  setState: async (input) =>
    Option.getOrNull(await runtime.runPromise(GitHubSessionRouteRepository.setState(input))),
  removeAllForUser: async (userId, at) => {
    await runtime.runPromise(GitHubSessionRouteRepository.removeAllForUser(userId, at))
  },
  listPendingMutations: (at, limit) =>
    runtime.runPromise(GitHubSessionRouteRepository.listPendingMutations(at, limit)),
  markMutationDelivered: async (id, deliveredAt) => {
    await runtime.runPromise(GitHubSessionRouteRepository.markMutationDelivered(id, deliveredAt))
  },
  markMutationFailed: async (input) => {
    await runtime.runPromise(GitHubSessionRouteRepository.markMutationFailed(input))
  }
}

const syncRelayRegistration = async (
  relayUrl: string,
  secret: string,
  input: {
    readonly mutationId: string
    readonly userId: string
    readonly installationId: string
    readonly state: GitHubRelayRegistrationState
    readonly generation: number
  }
): Promise<void> => {
  const body = JSON.stringify(input)
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  const response = await fetch(new URL("/internal/installations", relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jingler-timestamp": timestamp,
      "x-jingler-signature": `sha256=${signature}`
    },
    body
  })
  if (!response.ok) throw new Error("GitHub relay registration failed")
}

const signedRelayPost = async (
  relayUrl: string,
  secret: string,
  path: string,
  input: unknown
): Promise<void> => {
  const body = JSON.stringify(input)
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  const response = await fetch(new URL(path, relayUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jingler-timestamp": timestamp,
      "x-jingler-signature": `sha256=${signature}`
    },
    body
  })
  if (!response.ok) throw new Error("GitHub relay workflow creation failed")
}

let cachedClient: GitHubAppClient | undefined
let cachedCipher: GitHubTokenCipher | undefined

const unavailable = (): never => {
  throw new Error("GitHub App is not configured")
}

/**
 * Disabled installations still expose an authenticated, renderer-safe status
 * response. Keep unavailable protocol services inert so reading that status
 * never constructs cryptographic state from missing configuration.
 */
const unavailableClient: GitHubAppClient = {
  authorizationUrl: unavailable,
  installationUrl: async () => unavailable(),
  exchangeCode: async () => unavailable(),
  refreshUserToken: async () => unavailable(),
  getUser: async () => unavailable(),
  listInstallations: async () => unavailable(),
  listInstallationRepositories: async () => unavailable(),
  createInstallationAccessToken: async () => unavailable(),
  createPullRequest: async () => unavailable(),
  revokeUserToken: async () => unavailable()
}

const unavailableCipher: GitHubTokenCipher = {
  encrypt: unavailable,
  decrypt: unavailable
}

const defaultDependencies = (): GitHubRoutesDependencies => {
  const config = {
    appId: env.githubAppId,
    clientId: env.githubAppClientId,
    clientSecret: env.githubAppClientSecret,
    privateKey: env.githubAppPrivateKey,
    relayUrl: env.githubAppRelayUrl,
    relaySigningSecret: env.githubAppRelaySigningSecret,
    tokenEncryptionKey: env.githubAppTokenEncryptionKey,
    tokenEncryptionPreviousKey: env.githubAppTokenEncryptionPreviousKey
  }
  const isAvailable = env.githubAppEnabled && env.githubAppConfigured
  if (isAvailable) {
    cachedClient ??= createGitHubAppClient(config)
    cachedCipher ??= createGitHubTokenCipher(
      config.tokenEncryptionKey,
      config.tokenEncryptionPreviousKey || undefined
    )
  }
  return {
    enabled: env.githubAppEnabled,
    configured: env.githubAppConfigured,
    desktopRedirect: env.desktopRedirect,
    relayUrl: config.relayUrl,
    relaySigningSecret: config.relaySigningSecret,
    getUserId: async (headers) => {
      const session = await getAuth()
        .api.getSession({ headers })
        .catch(() => null)
      return session?.user.id ?? null
    },
    github: cachedClient ?? unavailableClient,
    cipher: cachedCipher ?? unavailableCipher,
    store: repositoryStore,
    sessionRoutes: sessionRouteStore,
    syncRelayRegistration: isAvailable
      ? (input) => syncRelayRegistration(config.relayUrl, config.relaySigningSecret, input)
      : undefined,
    syncRelaySessionRoute: isAvailable
      ? (input) =>
          signedRelayPost(
            config.relayUrl,
            config.relaySigningSecret,
            "/internal/session-routes",
            input
          )
      : undefined
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
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
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
  installation: GitHubInstallationRecord,
  repositories: ReadonlyArray<GitHubApiRepository> = []
): GitHubAppInstallationView => ({
  id: installation.installationId,
  account: {
    id: installation.accountId,
    login: installation.accountLogin,
    type: installation.accountType,
    avatarUrl: installation.accountAvatarUrl
  },
  repositorySelection: installation.repositorySelection,
  repositories: repositories.map((repository) => ({ ...repository })),
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
  const selectedInstallations = installations.filter(
    (installation) =>
      installation.repositorySelection === "selected" && installation.suspendedAt === null
  )
  let selectedRepositoryEntries: ReadonlyArray<
    readonly [string, ReadonlyArray<GitHubApiRepository>]
  > = []
  if (selectedInstallations.length > 0) {
    const token = await activeUserToken(dependencies, authorization)
    selectedRepositoryEntries = await Promise.all(
      selectedInstallations.map(
        async (installation) =>
          [
            installation.installationId,
            await dependencies.github.listInstallationRepositories(
              token.accessToken,
              installation.installationId
            )
          ] as const
      )
    )
  }
  const selectedRepositories = new Map(selectedRepositoryEntries)
  return {
    enabled: dependencies.enabled && dependencies.configured,
    connected: true,
    user: {
      id: authorization.githubUserId,
      login: authorization.githubLogin,
      name: authorization.githubName,
      avatarUrl: authorization.githubAvatarUrl
    },
    installations: installations.map((installation) =>
      toInstallationView(installation, selectedRepositories.get(installation.installationId) ?? [])
    ),
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
      fields: {
        accessTokenEncrypted: authorization.accessTokenEncrypted,
        refreshTokenEncrypted: authorization.refreshTokenEncrypted,
        accessTokenExpiresAt: authorization.accessTokenExpiresAt,
        refreshTokenExpiresAt: authorization.refreshTokenExpiresAt
      }
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

const relayRetryDelayMs = (attemptCount: number): number =>
  Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attemptCount, 8))

/** Best-effort durable handoff. A failed row remains due for a later request. */
export const flushGitHubRelayOutbox = async (
  dependencies: GitHubRoutesDependencies
): Promise<void> => {
  if (!dependencies.syncRelayRegistration) return
  const now = (dependencies.now ?? (() => new Date()))()
  const mutations = await dependencies.store.listPendingRelayMutations(now, 50)
  for (const mutation of mutations) {
    try {
      await dependencies.syncRelayRegistration({
        mutationId: mutation.id,
        userId: mutation.userId,
        installationId: mutation.installationId,
        state: mutation.desiredState,
        generation: mutation.generation
      })
      await dependencies.store.markRelayMutationDelivered(
        mutation.id,
        (dependencies.now ?? (() => new Date()))()
      )
    } catch (error) {
      const updatedAt = (dependencies.now ?? (() => new Date()))()
      await dependencies.store.markRelayMutationFailed({
        id: mutation.id,
        retryAt: new Date(updatedAt.getTime() + relayRetryDelayMs(mutation.attemptCount)),
        updatedAt,
        error: error instanceof Error ? error.name : "RelayUnavailable"
      })
    }
  }
}

/** Hand pending session route state to deterministic relay Workflows. */
export const flushGitHubSessionRouteOutbox = async (
  dependencies: GitHubRoutesDependencies
): Promise<void> => {
  if (!dependencies.syncRelaySessionRoute) return
  const now = (dependencies.now ?? (() => new Date()))()
  const mutations = await dependencies.sessionRoutes.listPendingMutations(now, 50)
  for (const mutation of mutations) {
    try {
      await dependencies.syncRelaySessionRoute({
        mutationId: mutation.id,
        state: mutation.desiredState,
        userId: mutation.userId,
        relaySessionId: mutation.relaySessionId,
        installationId: mutation.installationId,
        repositoryId: mutation.repositoryId,
        pullRequestNumber: mutation.pullRequestNumber,
        generation: mutation.generation
      })
      await dependencies.sessionRoutes.markMutationDelivered(
        mutation.id,
        (dependencies.now ?? (() => new Date()))()
      )
    } catch (error) {
      const updatedAt = (dependencies.now ?? (() => new Date()))()
      await dependencies.sessionRoutes.markMutationFailed({
        id: mutation.id,
        retryAt: new Date(updatedAt.getTime() + relayRetryDelayMs(mutation.attemptCount)),
        updatedAt,
        error: error instanceof Error ? error.name : "RelayUnavailable"
      })
    }
  }
}

export const drainGitHubOutboxes = async (): Promise<void> => {
  const dependencies = defaultDependencies()
  await flushGitHubRelayOutbox(dependencies)
  await flushGitHubSessionRouteOutbox(dependencies)
}

const revokeUnavailableSessionRoutes = async (
  dependencies: GitHubRoutesDependencies,
  userId: string,
  accessToken: string,
  installations: ReadonlyArray<GitHubApiInstallation>,
  at: Date
): Promise<void> => {
  const routes = (await dependencies.sessionRoutes.listByUserId(userId)).filter(
    (route) => route.state === "active"
  )
  const activeInstallations = new Map(
    installations
      .filter((installation) => installation.suspendedAt === null)
      .map((installation) => [installation.id, installation] as const)
  )
  const repositoriesByInstallation = new Map<string, ReadonlySet<string>>()
  for (const route of routes) {
    if (!activeInstallations.has(route.installationId)) {
      await dependencies.sessionRoutes.setState({
        userId,
        relaySessionId: route.relaySessionId,
        state: "removed",
        at
      })
      continue
    }
    let repositories = repositoriesByInstallation.get(route.installationId)
    if (!repositories) {
      const listed = await dependencies.github.listInstallationRepositories(
        accessToken,
        route.installationId
      )
      repositories = new Set(listed.map((repository) => repository.id))
      repositoriesByInstallation.set(route.installationId, repositories)
    }
    if (!repositories.has(route.repositoryId)) {
      await dependencies.sessionRoutes.setState({
        userId,
        relaySessionId: route.relaySessionId,
        state: "removed",
        at
      })
    }
  }
}

/** Reconcile identity and installations from GitHub's user-authorized view. */
const reconcile = async (
  dependencies: GitHubRoutesDependencies,
  userId: string
): Promise<GitHubAuthorizationRecord | null> => {
  const authorization = await dependencies.store.findAuthorizationByUserId(userId)
  if (!authorization) return null
  const token = await activeUserToken(dependencies, authorization)
  const [githubUser, installations] = await Promise.all([
    dependencies.github.getUser(token.accessToken),
    dependencies.github.listInstallations(token.accessToken)
  ])
  const refreshedAt = (dependencies.now ?? (() => new Date()))()
  const saved = await dependencies.store.saveConnection({
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
  await revokeUnavailableSessionRoutes(
    dependencies,
    userId,
    token.accessToken,
    installations,
    refreshedAt
  )
  await flushGitHubRelayOutbox(dependencies)
  await flushGitHubSessionRouteOutbox(dependencies)
  return saved
}

const parseInstallationId = (raw: string | undefined): string | null =>
  raw && /^\d+$/.test(raw) ? raw : null

const parseRepositoryId = (raw: unknown): string | null =>
  typeof raw === "string" && /^\d+$/.test(raw) ? raw : null

const parseSessionId = (raw: unknown): string | null =>
  typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(raw) ? raw : null

const parseRelaySessionId = (raw: unknown): string | null =>
  typeof raw === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(raw) ? raw : null

const parsePullRequestNumber = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null

const sessionRouteView = (route: GitHubSessionRouteRecord): GitHubSessionRoute => ({
  sessionId: route.sessionId,
  relaySessionId: route.relaySessionId,
  installationId: route.installationId,
  repositoryId: route.repositoryId,
  pullRequestNumber: route.pullRequestNumber,
  state: route.state,
  updatedAt: route.updatedAt.toISOString()
})

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
  const statusCache = new Map<
    string,
    { readonly value: GitHubAppConnectionStatus; readonly expiresAt: number }
  >()
  const reconcileRequests = new Map<string, Promise<GitHubAuthorizationRecord | null>>()

  const invalidateStatus = (userId: string): void => {
    statusCache.delete(userId)
  }

  const readStatus = async (
    dependencies: GitHubRoutesDependencies,
    userId: string
  ): Promise<GitHubAppConnectionStatus> => {
    const now = (dependencies.now ?? (() => new Date()))().getTime()
    const cached = statusCache.get(userId)
    if (cached && cached.expiresAt > now) return cached.value
    const value = await statusFor(dependencies, userId)
    statusCache.set(userId, { value, expiresAt: now + STATUS_CACHE_TTL_MS })
    return value
  }

  const refreshConnection = async (
    dependencies: GitHubRoutesDependencies,
    userId: string
  ): Promise<GitHubAuthorizationRecord | null> => {
    const inFlight = reconcileRequests.get(userId)
    if (inFlight) return inFlight
    const request = reconcile(dependencies, userId)
    reconcileRequests.set(userId, request)
    try {
      return await request
    } finally {
      reconcileRequests.delete(userId)
      invalidateStatus(userId)
    }
  }

  const reconcileIfStale = async (
    dependencies: GitHubRoutesDependencies,
    userId: string
  ): Promise<GitHubAuthorizationRecord | null> => {
    const authorization = await dependencies.store.findAuthorizationByUserId(userId)
    if (!authorization) return null
    const now = (dependencies.now ?? (() => new Date()))().getTime()
    if (now - authorization.lastRefreshedAt.getTime() < RECONCILE_TTL_MS) {
      return authorization
    }
    return refreshConnection(dependencies, userId)
  }

  const authenticated = async (
    headers: Headers,
    dependencies: GitHubRoutesDependencies
  ): Promise<string | null> => dependencies.getUserId(headers)

  const available = (dependencies: GitHubRoutesDependencies): boolean =>
    dependencies.enabled && dependencies.configured

  const start = async (request: Request, kind: GitHubCallbackStateKind): Promise<Response> => {
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
    // No cookie check: GitHub redirects into the OS browser, which holds no
    // api.jingler.dev session. The state — unguessable, single-use, expiring —
    // authenticates the callback, and its stored row is the owning user.
    const url = new URL(request.url)
    const state = url.searchParams.get("state")
    const code = url.searchParams.get("code")
    if (!state) return callbackError()
    const now = (dependencies.now ?? (() => new Date()))()
    const callbackState = await dependencies.store.consumeCallbackState({
      stateHash: hashGitHubCallbackState(state),
      // GitHub's request_oauth_on_install flow starts from the installation
      // URL and legitimately returns its state to the OAuth callback.
      kinds: ["authorize", "install"],
      at: now
    })
    if (!callbackState) return callbackError()
    const userId = callbackState.userId
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
      invalidateStatus(userId)
      await flushGitHubRelayOutbox(dependencies)
      return Response.redirect(withQuery(callbackState.redirectUri, { github: "connected" }), 302)
    } catch {
      return callbackError()
    }
  }

  const finishSetup = async (request: Request): Promise<Response> => {
    const dependencies = resolveDependencies()
    if (!available(dependencies)) return callbackError()
    // Self-authenticating on the state row — see finishOAuth. The OS browser
    // that GitHub redirects here carries no api.jingler.dev session cookie.
    const url = new URL(request.url)
    const state = url.searchParams.get("state")
    const installationId = parseInstallationId(url.searchParams.get("installation_id") ?? undefined)
    if (!state || !installationId) return callbackError()
    const now = (dependencies.now ?? (() => new Date()))()
    const callbackState = await dependencies.store.consumeCallbackState({
      stateHash: hashGitHubCallbackState(state),
      kinds: ["install"],
      at: now
    })
    if (!callbackState) return callbackError()
    const userId = callbackState.userId
    try {
      await refreshConnection(dependencies, userId)
      const installation = await dependencies.store.findInstallationForUser(userId, installationId)
      if (!installation) return callbackError()
      return Response.redirect(withQuery(callbackState.redirectUri, { github: "connected" }), 302)
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
      await flushGitHubRelayOutbox(dependencies)
      return c.json(await readStatus(dependencies, userId), 200, noStore)
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
      await flushGitHubRelayOutbox(dependencies)
      await refreshConnection(dependencies, userId)
      return c.json(await readStatus(dependencies, userId), 200, noStore)
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
    let accessToken: string | null = null
    if (authorization) {
      try {
        accessToken = dependencies.cipher.decrypt(authorization.accessTokenEncrypted)
      } catch {
        accessToken = null
      }
    }
    // The local delete and durable relay revocations commit first. External
    // availability can never keep this user connected in Jingler.
    const disconnectedAt = (dependencies.now ?? (() => new Date()))()
    await dependencies.sessionRoutes.removeAllForUser(userId, disconnectedAt)
    await dependencies.store.disconnect(userId)
    invalidateStatus(userId)
    if (accessToken) {
      try {
        await dependencies.github.revokeUserToken(accessToken)
      } catch {
        // GitHub token revocation is independently best-effort.
      }
    }
    await flushGitHubRelayOutbox(dependencies)
    await flushGitHubSessionRouteOutbox(dependencies)
    return c.body(null, 204, noStore)
  })

  routes.get("/session-routes", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    await flushGitHubSessionRouteOutbox(dependencies)
    const routeRows = await dependencies.sessionRoutes.listByUserId(userId)
    return c.json({ routes: routeRows.map(sessionRouteView) }, 200, noStore)
  })

  routes.post("/session-routes", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json({ error: "GitHub App is not configured" }, 503, noStore)
    }
    let input: {
      readonly sessionId: string | null
      readonly installationId: string | null
      readonly repositoryId: string | null
      readonly pullRequestNumber: number | null
    } = {
      sessionId: null,
      installationId: null,
      repositoryId: null,
      pullRequestNumber: null
    }
    try {
      const body: unknown = await c.req.json()
      const record =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {}
      input = {
        sessionId: parseSessionId(record.sessionId),
        installationId: parseInstallationId(
          typeof record.installationId === "string" ? record.installationId : undefined
        ),
        repositoryId: parseRepositoryId(record.repositoryId),
        pullRequestNumber: parsePullRequestNumber(record.pullRequestNumber)
      }
    } catch {
      // The uniform validation response below deliberately reveals no ownership state.
    }
    if (
      !input.sessionId ||
      !input.installationId ||
      !input.repositoryId ||
      !input.pullRequestNumber
    ) {
      return c.json({ error: "Valid session route fields are required" }, 400, noStore)
    }
    try {
      await reconcileIfStale(dependencies, userId)
      const installation = await dependencies.store.findInstallationForUser(
        userId,
        input.installationId
      )
      if (!installation || installation.suspendedAt) {
        return c.json({ error: "Active installation required" }, 403, noStore)
      }
      const authorization = await dependencies.store.findAuthorizationByUserId(userId)
      if (!authorization) return c.json({ error: "GitHub authorization required" }, 403, noStore)
      const token = await activeUserToken(dependencies, authorization)
      const repositories = await dependencies.github.listInstallationRepositories(
        token.accessToken,
        input.installationId
      )
      if (!repositories.some((repository) => repository.id === input.repositoryId)) {
        return c.json({ error: "Repository is not available to this installation" }, 403, noStore)
      }
      const route = await dependencies.sessionRoutes.upsertActive({
        userId,
        sessionId: input.sessionId,
        relaySessionId: (
          dependencies.randomRelaySessionId ?? (() => randomBytes(24).toString("base64url"))
        )(),
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        pullRequestNumber: input.pullRequestNumber,
        at: (dependencies.now ?? (() => new Date()))()
      })
      await flushGitHubSessionRouteOutbox(dependencies)
      return c.json({ route: sessionRouteView(route) }, 200, noStore)
    } catch {
      return c.json({ error: "GitHub session route rejected" }, 409, noStore)
    }
  })

  routes.post("/session-grant", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json({ error: "GitHub App is not configured" }, 503, noStore)
    }
    let relaySessionId: string | null = null
    try {
      const body: unknown = await c.req.json()
      if (body && typeof body === "object" && !Array.isArray(body)) {
        relaySessionId = parseRelaySessionId((body as Record<string, unknown>).relaySessionId)
      }
    } catch {
      relaySessionId = null
    }
    if (!relaySessionId) return c.json({ error: "relaySessionId is required" }, 400, noStore)
    try {
      await reconcileIfStale(dependencies, userId)
    } catch {
      return c.json({ error: "GitHub repository access could not be verified" }, 502, noStore)
    }
    const route = await dependencies.sessionRoutes.findForUser(userId, relaySessionId)
    if (!route || route.state !== "active") {
      return c.json({ error: "Active session route required" }, 403, noStore)
    }
    const installation = await dependencies.store.findInstallationForUser(
      userId,
      route.installationId
    )
    if (!installation || installation.suspendedAt) {
      return c.json({ error: "Active installation required" }, 403, noStore)
    }
    const nowSeconds = Math.floor((dependencies.now ?? (() => new Date()))().getTime() / 1_000)
    return c.json(
      issueGitHubSessionRelayGrant(
        { userId, installationId: route.installationId, relaySessionId },
        {
          relayUrl: dependencies.relayUrl,
          relaySigningSecret: dependencies.relaySigningSecret
        },
        nowSeconds,
        (dependencies.randomId ?? randomUUID)()
      ),
      200,
      noStore
    )
  })

  const transitionSessionRoute = async (
    c: Context,
    state: "archived" | "removed"
  ): Promise<Response> => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    const relaySessionId = parseRelaySessionId(c.req.param("relaySessionId"))
    if (!relaySessionId) return c.json({ error: "Invalid session route" }, 400, noStore)
    const route = await dependencies.sessionRoutes.setState({
      userId,
      relaySessionId,
      state,
      at: (dependencies.now ?? (() => new Date()))()
    })
    if (!route) return c.json({ error: "Session route not found" }, 404, noStore)
    await flushGitHubSessionRouteOutbox(dependencies)
    return state === "removed"
      ? c.body(null, 204, noStore)
      : c.json({ route: sessionRouteView(route) }, 200, noStore)
  }

  routes.post("/session-routes/:relaySessionId/archive", (c) =>
    transitionSessionRoute(c, "archived")
  )
  routes.post("/session-routes/:relaySessionId/unlink", (c) => transitionSessionRoute(c, "removed"))
  routes.delete("/session-routes/:relaySessionId", (c) => transitionSessionRoute(c, "removed"))

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
      await reconcileIfStale(dependencies, userId)
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
          typeof record.installationId === "string" ? record.installationId : undefined
        )
        scopes =
          record.scopes === undefined
            ? []
            : Array.isArray(record.scopes) &&
                record.scopes.every((scope) => typeof scope === "string")
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
      await reconcileIfStale(dependencies, userId)
      const installation = await dependencies.store.findInstallationForUser(userId, installationId)
      if (!installation || installation.suspendedAt) {
        return c.json({ error: "Active installation required" }, 403, noStore)
      }
      const scope = installationTokenScope(scopes, installation)
      if (!scope)
        return c.json({ error: "Requested GitHub scopes are not available" }, 403, noStore)
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

  /**
   * Creates a pull request as the connected GitHub user. Organization rules can
   * reject installation actors even when the same installation may push and
   * read the repository, so the user's OAuth token remains server-side here.
   */
  routes.post("/pull-requests", async (c) => {
    const dependencies = resolveDependencies()
    const userId = await authenticated(c.req.raw.headers, dependencies)
    if (!userId) return c.json({ error: "Authentication required" }, 401, noStore)
    if (!available(dependencies)) {
      return c.json({ error: "GitHub App is not configured" }, 503, noStore)
    }
    let input: {
      installationId: string | null
      repository: string | null
      title: string | null
      body: string | null
      head: string | null
      base: string | null
      draft: boolean | null
    } = {
      installationId: null,
      repository: null,
      title: null,
      body: null,
      head: null,
      base: null,
      draft: null
    }
    try {
      const value: unknown = await c.req.json()
      const record =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      const text = (candidate: unknown, maximum: number): string | null =>
        typeof candidate === "string" && candidate.length > 0 && candidate.length <= maximum
          ? candidate
          : null
      input = {
        installationId: parseInstallationId(
          typeof record.installationId === "string" ? record.installationId : undefined
        ),
        repository: text(record.repository, 200),
        title: text(record.title, 256),
        body: typeof record.body === "string" && record.body.length <= 100_000 ? record.body : null,
        head: text(record.head, 300),
        base: text(record.base, 300),
        draft: typeof record.draft === "boolean" ? record.draft : null
      }
    } catch {
      // The uniform validation response below reveals no connection state.
    }
    if (
      !input.installationId ||
      !input.repository ||
      !input.title ||
      input.body === null ||
      !input.head ||
      !input.base ||
      input.draft === null ||
      !/^[^/\s]+\/[^/\s]+$/.test(input.repository)
    ) {
      return c.json({ error: "Valid pull request fields are required" }, 400, noStore)
    }
    try {
      await reconcileIfStale(dependencies, userId)
      const installation = await dependencies.store.findInstallationForUser(
        userId,
        input.installationId
      )
      if (!installation || installation.suspendedAt) {
        return c.json({ error: "Active installation required" }, 403, noStore)
      }
      const authorization = await dependencies.store.findAuthorizationByUserId(userId)
      if (!authorization) return c.json({ error: "GitHub authorization required" }, 403, noStore)
      const token = await activeUserToken(dependencies, authorization)
      const repositories = await dependencies.github.listInstallationRepositories(
        token.accessToken,
        input.installationId
      )
      if (
        !repositories.some(
          (repository) => repository.fullName.toLowerCase() === input.repository!.toLowerCase()
        )
      ) {
        return c.json({ error: "Repository is not available to this installation" }, 403, noStore)
      }
      const pullRequestNumber = await dependencies.github.createPullRequest(token.accessToken, {
        repository: input.repository,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft
      })
      return c.json({ number: pullRequestNumber }, 201, noStore)
    } catch (error) {
      if (error instanceof GitHubAppError && error.status === 422) {
        return c.json({ error: "GitHub rejected the pull request values" }, 422, noStore)
      }
      return c.json({ error: "Pull request creation failed" }, 502, noStore)
    }
  })

  return routes
}

export { createGitHubRoutes as createGithubRoutes }
