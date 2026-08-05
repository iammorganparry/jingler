import type {
  GitHubAppConnectionStatus,
  GitHubAppInstallation,
  GitHubDesktopGrantResponse,
  GitHubSessionRelayGrantResponse,
  GitHubSessionRoute
} from "@jingler/core"
import { GitHubApiError } from "@jingler/core"
import { Effect } from "effect"
import { SecretStore } from "./secret-store.js"

const DEFAULT_BASE_URL = "http://localhost:9100"
const GRANT_REFRESH_SKEW_SECONDS = 30
const WORKFLOW_DIRECTORY = ".github/workflows/"

/** Minimum GitHub App permissions needed to push the inspected paths. */
export const githubPushPermissions = (
  paths: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const changesWorkflow = paths.some((path) => {
    const slashes = path.replaceAll("\\", "/")
    const normalized = slashes.startsWith("./") ? slashes.slice(2) : slashes
    return normalized.startsWith(WORKFLOW_DIRECTORY)
  })
  return changesWorkflow
    ? ["contents:write", "workflows:write"]
    : ["contents:write"]
}

export interface GitHubRelayGrant {
  readonly relayUrl: string
  readonly grant: string
  readonly installationId: string
  readonly expiresAt: number
  readonly scopes: ReadonlyArray<string>
}

/** Relay socket credential for exactly one opaque session Durable Object. */
export interface GitHubSessionRelayGrant {
  readonly relayUrl: string
  readonly grant: string
  readonly installationId: string
  readonly relaySessionId: string
  readonly expiresAt: number
}

/** Short-lived installation credential. Kept in Electron main memory only. */
export interface GitHubInstallationCredential {
  readonly token: string
  readonly installationId: string
  readonly expiresAt: string
}

export interface GitHubAuthClient {
  readonly status: () => Promise<GitHubAppConnectionStatus>
  /** Authenticated GitHub user identity; never inferred from an installation token. */
  readonly viewerLogin: () => Promise<string | null>
  readonly grantForInstallation: (
    installationId: string,
    scopes?: ReadonlyArray<string>
  ) => Promise<GitHubRelayGrant>
  readonly grantForOwner: (
    owner: string,
    scopes?: ReadonlyArray<string>
  ) => Promise<GitHubRelayGrant>
  readonly sessionRoutes: () => Promise<ReadonlyArray<GitHubSessionRoute>>
  readonly upsertSessionRoute: (input: {
    readonly sessionId: string
    readonly installationId: string
    readonly repositoryId: string
    readonly pullRequestNumber: number
  }) => Promise<GitHubSessionRoute>
  readonly grantForSession: (relaySessionId: string) => Promise<GitHubSessionRelayGrant>
  readonly archiveSessionRoute: (relaySessionId: string) => Promise<GitHubSessionRoute>
  readonly unlinkSessionRoute: (relaySessionId: string) => Promise<void>
  readonly credentialsForInstallation: (
    installationId: string,
    repository: string,
    permissions: ReadonlyArray<string>
  ) => Promise<GitHubInstallationCredential>
  readonly credentialsForOwner: (
    owner: string,
    repository: string,
    permissions: ReadonlyArray<string>
  ) => Promise<GitHubInstallationCredential>
  readonly defaultPluginGrant: (
    scopes: ReadonlyArray<string>
  ) => Promise<{ readonly grant: GitHubRelayGrant; readonly account: string } | null>
  readonly invalidate: (installationId: string) => void
}

export interface GitHubAuthClientOptions {
  readonly bearer: () => Promise<string | null>
  readonly fetch?: typeof fetch
  readonly baseUrl?: () => string
  readonly now?: () => Date
}

const apiBaseUrl = (): string =>
  (process.env.JINGLER_GITHUB_URL ?? process.env.JINGLER_AUTH_URL ?? DEFAULT_BASE_URL).replace(
    /\/$/,
    ""
  )

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const string = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const errorForStatus = (status: number, retryAt?: string): GitHubApiError => {
  if (status === 401) {
    return new GitHubApiError({
      reason: "token-expired",
      message: "Your Jingler session or GitHub grant expired. Sign in again and refresh GitHub.",
      status
    })
  }
  if (status === 403) {
    return new GitHubApiError({
      reason: "repository-access",
      message: "The GitHub App installation does not grant access to this repository.",
      status
    })
  }
  if (status === 429) {
    return new GitHubApiError({
      reason: "rate-limited",
      message: retryAt
        ? `GitHub's rate limit was reached. Retry after ${retryAt}.`
        : "GitHub's rate limit was reached. Retry after it resets.",
      status,
      ...(retryAt ? { retryAt } : {})
    })
  }
  if (status === 422) {
    return new GitHubApiError({
      reason: "validation",
      message: "GitHub rejected the request. Refresh the pull request and check the submitted values.",
      status
    })
  }
  return new GitHubApiError({
    reason: status === 404 ? "not-found" : "unavailable",
    message:
      status === 404
        ? "The requested GitHub resource no longer exists or is not accessible."
        : "The GitHub connection service could not complete the request.",
    status
  })
}

const parseStatus = (value: unknown): GitHubAppConnectionStatus | null => {
  const body = record(value)
  if (
    !body ||
    typeof body.enabled !== "boolean" ||
    typeof body.connected !== "boolean" ||
    !Array.isArray(body.installations) ||
    !(body.lastRefreshedAt === null || typeof body.lastRefreshedAt === "string")
  ) {
    return null
  }
  const installations = body.installations.flatMap((candidate): ReadonlyArray<GitHubAppInstallation> => {
    const installation = record(candidate)
    const account = record(installation?.account)
    const id = string(installation?.id)
    const accountId = string(account?.id)
    const login = string(account?.login)
    const type = string(account?.type)
    const repositorySelection = installation?.repositorySelection
    const status = installation?.status
    if (
      !installation ||
      !account ||
      !id ||
      !accountId ||
      !login ||
      !type ||
      (repositorySelection !== "all" && repositorySelection !== "selected") ||
      (status !== "active" && status !== "suspended")
    ) {
      return []
    }
    const permissions = record(installation.permissions) ?? {}
    const repositories = Array.isArray(installation.repositories)
      ? installation.repositories.flatMap((candidate) => {
          const repository = record(candidate)
          const repositoryId = string(repository?.id)
          const fullName = string(repository?.fullName)
          return repositoryId && fullName ? [{ id: repositoryId, fullName }] : []
        })
      : []
    return [{
      id,
      account: {
        id: accountId,
        login,
        type,
        avatarUrl: string(account.avatarUrl)
      },
      repositorySelection,
      repositories,
      permissions: Object.fromEntries(
        Object.entries(permissions).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      ),
      status,
      suspendedAt: string(installation.suspendedAt)
    }]
  })
  const user = record(body.user)
  return {
    enabled: body.enabled,
    connected: body.connected,
    user:
      user && string(user.id) && string(user.login)
        ? {
            id: string(user.id)!,
            login: string(user.login)!,
            name: string(user.name),
            avatarUrl: string(user.avatarUrl)
          }
        : null,
    installations,
    lastRefreshedAt: body.lastRefreshedAt as string | null
  }
}

const parseGrant = (value: unknown): GitHubDesktopGrantResponse | null => {
  const body = record(value)
  const claims = record(body?.claims)
  const relayUrl = string(body?.relayUrl)
  const grant = string(body?.grant)
  const installationId = string(claims?.installationId)
  const expiresAt = number(claims?.expiresAt)
  if (!relayUrl || !grant || !installationId || expiresAt === null) return null
  return {
    relayUrl,
    grant,
    claims: {
      version: 1,
      issuer: "jingler",
      audience: "jingler-github-relay",
      subject: string(claims?.subject) ?? "",
      installationId,
      issuedAt: number(claims?.issuedAt) ?? 0,
      expiresAt,
      grantId: string(claims?.grantId) ?? ""
    }
  }
}

const parseSessionRoute = (value: unknown): GitHubSessionRoute | null => {
  const route = record(value)
  const sessionId = string(route?.sessionId)
  const relaySessionId = string(route?.relaySessionId)
  const installationId = string(route?.installationId)
  const repositoryId = string(route?.repositoryId)
  const state = route?.state
  const pullRequestNumber = number(route?.pullRequestNumber)
  const updatedAt = string(route?.updatedAt)
  if (
    !route ||
    !sessionId ||
    !relaySessionId ||
    !installationId ||
    !repositoryId ||
    pullRequestNumber === null ||
    !Number.isSafeInteger(pullRequestNumber) ||
    (state !== "active" && state !== "archived" && state !== "removed") ||
    !updatedAt
  ) {
    return null
  }
  return {
    sessionId,
    relaySessionId,
    installationId,
    repositoryId,
    pullRequestNumber,
    state,
    updatedAt
  }
}

const parseSessionGrant = (value: unknown): GitHubSessionRelayGrantResponse | null => {
  const body = record(value)
  const claims = record(body?.claims)
  const relayUrl = string(body?.relayUrl)
  const grant = string(body?.grant)
  const installationId = string(claims?.installationId)
  const relaySessionId = string(claims?.relaySessionId)
  const expiresAt = number(claims?.expiresAt)
  if (!relayUrl || !grant || !installationId || !relaySessionId || expiresAt === null) return null
  return {
    relayUrl,
    grant,
    claims: {
      version: 1,
      issuer: "jingler",
      audience: "jingler-github-relay",
      subject: string(claims?.subject) ?? "",
      installationId,
      relaySessionId,
      issuedAt: number(claims?.issuedAt) ?? 0,
      expiresAt,
      grantId: string(claims?.grantId) ?? ""
    }
  }
}

export const makeGitHubAuthClient = (options: GitHubAuthClientOptions): GitHubAuthClient => {
  const request = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? apiBaseUrl
  const now = options.now ?? (() => new Date())
  const grants = new Map<string, GitHubRelayGrant>()
  const sessionGrants = new Map<string, GitHubSessionRelayGrant>()
  const credentials = new Map<string, GitHubInstallationCredential>()
  const credentialKey = (installationId: string, scopes: ReadonlyArray<string>): string =>
    `${installationId}:${[...new Set(scopes)].sort().join(",")}`

  const authenticatedRequest = async (
    path: string,
    init: RequestInit = {}
  ): Promise<Response> => {
    const bearer = await options.bearer()
    if (!bearer) {
      throw new GitHubApiError({
        reason: "token-expired",
        message: "Sign in to Jingler before using the GitHub App."
      })
    }
    let response: Response
    try {
      response = await request(`${baseUrl()}${path}`, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
          authorization: `Bearer ${bearer}`
        }
      })
    } catch {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "Could not reach the GitHub connection service."
      })
    }
    if (!response.ok) {
      const reset = response.headers.get("x-ratelimit-reset")
      const resetSeconds = reset === null ? null : Number(reset)
      const retryAt =
        resetSeconds !== null && Number.isFinite(resetSeconds)
          ? new Date(resetSeconds * 1_000).toISOString()
          : undefined
      throw errorForStatus(response.status, retryAt)
    }
    return response
  }

  const status = async (): Promise<GitHubAppConnectionStatus> => {
    const response = await authenticatedRequest("/api/github/status")
    const parsed = parseStatus(await response.json().catch(() => null))
    if (!parsed) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned an invalid status response."
      })
    }
    return parsed
  }

  const grantForInstallation = async (
    installationId: string,
    scopes: ReadonlyArray<string> = []
  ): Promise<GitHubRelayGrant> => {
    const cached = grants.get(installationId)
    const nowSeconds = Math.floor(now().getTime() / 1_000)
    if (cached && cached.expiresAt - GRANT_REFRESH_SKEW_SECONDS > nowSeconds) return cached
    grants.delete(installationId)
    const response = await authenticatedRequest("/api/github/desktop-grant", {
      method: "POST",
      body: JSON.stringify({ installationId, scopes: [...scopes] })
    })
    const parsed = parseGrant(await response.json().catch(() => null))
    if (!parsed || parsed.claims.installationId !== installationId) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned an invalid desktop grant."
      })
    }
    const grant: GitHubRelayGrant = {
      relayUrl: parsed.relayUrl.replace(/\/$/, ""),
      grant: parsed.grant,
      installationId,
      expiresAt: parsed.claims.expiresAt,
      scopes: [...scopes]
    }
    grants.set(installationId, grant)
    return grant
  }

  const sessionRoutes = async (): Promise<ReadonlyArray<GitHubSessionRoute>> => {
    const response = await authenticatedRequest("/api/github/session-routes")
    const body = record(await response.json().catch(() => null))
    if (!Array.isArray(body?.routes)) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned invalid session routes."
      })
    }
    const routes = body.routes.map(parseSessionRoute)
    if (routes.some((route) => route === null)) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned invalid session routes."
      })
    }
    return routes.filter((route): route is GitHubSessionRoute => route !== null)
  }

  const upsertSessionRoute: GitHubAuthClient["upsertSessionRoute"] = async (input) => {
    const response = await authenticatedRequest("/api/github/session-routes", {
      method: "POST",
      body: JSON.stringify(input)
    })
    const body = record(await response.json().catch(() => null))
    const route = parseSessionRoute(body?.route)
    if (!route || route.sessionId !== input.sessionId) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned an invalid session route."
      })
    }
    return route
  }

  const grantForSession = async (relaySessionId: string): Promise<GitHubSessionRelayGrant> => {
    const cached = sessionGrants.get(relaySessionId)
    const nowSeconds = Math.floor(now().getTime() / 1_000)
    if (cached && cached.expiresAt - GRANT_REFRESH_SKEW_SECONDS > nowSeconds) return cached
    sessionGrants.delete(relaySessionId)
    const response = await authenticatedRequest("/api/github/session-grant", {
      method: "POST",
      body: JSON.stringify({ relaySessionId })
    })
    const parsed = parseSessionGrant(await response.json().catch(() => null))
    if (!parsed || parsed.claims.relaySessionId !== relaySessionId) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned an invalid session relay grant."
      })
    }
    const grant: GitHubSessionRelayGrant = {
      relayUrl: parsed.relayUrl.replace(/\/$/, ""),
      grant: parsed.grant,
      installationId: parsed.claims.installationId,
      relaySessionId,
      expiresAt: parsed.claims.expiresAt
    }
    sessionGrants.set(relaySessionId, grant)
    return grant
  }

  const archiveSessionRoute = async (relaySessionId: string): Promise<GitHubSessionRoute> => {
    const response = await authenticatedRequest(
      `/api/github/session-routes/${encodeURIComponent(relaySessionId)}/archive`,
      { method: "POST" }
    )
    const body = record(await response.json().catch(() => null))
    const route = parseSessionRoute(body?.route)
    if (!route || route.relaySessionId !== relaySessionId || route.state !== "archived") {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned an invalid archived session route."
      })
    }
    sessionGrants.delete(relaySessionId)
    return route
  }

  const unlinkSessionRoute = async (relaySessionId: string): Promise<void> => {
    await authenticatedRequest(`/api/github/session-routes/${encodeURIComponent(relaySessionId)}`, {
      method: "DELETE"
    })
    sessionGrants.delete(relaySessionId)
  }

  const installationForOwner = async (owner: string): Promise<GitHubAppInstallation> => {
    const connection = await status()
    const matching = connection.installations.find(
      (installation) => installation.account.login.toLowerCase() === owner.toLowerCase()
    )
    if (matching?.status === "suspended") {
      throw new GitHubApiError({
        reason: "installation-suspended",
        message: `The @${matching.account.login} GitHub App installation is suspended. Resume it in GitHub before retrying.`,
        installationId: matching.id
      })
    }
    if (!matching) {
      throw new GitHubApiError({
        reason: "repository-access",
        message: `Install the GitHub App for @${owner}, then refresh the connection.`,
        repository: `${owner}/*`
      })
    }
    return matching
  }

  const credentialsForInstallation = async (
    installationId: string,
    repository: string,
    permissions: ReadonlyArray<string>
  ): Promise<GitHubInstallationCredential> => {
    if (
      !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
      permissions.length === 0 ||
      permissions.some((permission) => !/^[a-z][a-z0-9_]*:(read|write)$/.test(permission))
    ) {
      throw new GitHubApiError({
        reason: "validation",
        message: "GitHub credentials require one exact repository and explicit permissions."
      })
    }
    const scopes = [...new Set([...permissions, `repository:${repository}`])].sort()
    const key = credentialKey(installationId, scopes)
    const cached = credentials.get(key)
    if (cached && Date.parse(cached.expiresAt) - GRANT_REFRESH_SKEW_SECONDS * 1_000 > now().getTime()) {
      return cached
    }
    credentials.delete(key)
    const response = await authenticatedRequest("/api/github/installation-credentials", {
      method: "POST",
      body: JSON.stringify({ installationId, scopes: [...new Set(scopes)].sort() })
    })
    const body = record(await response.json().catch(() => null))
    const token = string(body?.token)
    const returnedId = string(body?.installationId)
    const expiresAt = string(body?.expiresAt)
    if (!token || returnedId !== installationId || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
      throw new GitHubApiError({
        reason: "unavailable",
        message: "The GitHub connection service returned an invalid installation credential."
      })
    }
    const credential = { token, installationId, expiresAt }
    credentials.set(key, credential)
    return credential
  }

  return {
    status,
    viewerLogin: async () => (await status()).user?.login ?? null,
    grantForInstallation,
    grantForOwner: async (owner, scopes = []) => {
      const installation = await installationForOwner(owner)
      return grantForInstallation(installation.id, scopes)
    },
    sessionRoutes,
    upsertSessionRoute,
    grantForSession,
    archiveSessionRoute,
    unlinkSessionRoute,
    credentialsForInstallation,
    credentialsForOwner: async (owner, repository, permissions) => {
      if (repository.split("/")[0]?.toLowerCase() !== owner.toLowerCase()) {
        throw new GitHubApiError({
          reason: "repository-access",
          message: "The requested repository does not belong to this GitHub App installation."
        })
      }
      const installation = await installationForOwner(owner)
      return credentialsForInstallation(installation.id, repository, permissions)
    },
    defaultPluginGrant: async (scopes) => {
      const connection = await status()
      const active = connection.installations.find((installation) => installation.status === "active")
      if (!active) {
        const suspended = connection.installations[0]
        if (suspended) {
          throw new GitHubApiError({
            reason: "installation-suspended",
            message: `The @${suspended.account.login} GitHub App installation is suspended.`,
            installationId: suspended.id
          })
        }
        return null
      }
      return {
        grant: await grantForInstallation(active.id, scopes),
        account: connection.user?.login ?? active.account.login
      }
    },
    invalidate: (installationId) => {
      grants.delete(installationId)
      for (const key of credentials.keys()) {
        if (key.startsWith(`${installationId}:`)) credentials.delete(key)
      }
      for (const [relaySessionId, grant] of sessionGrants) {
        if (grant.installationId === installationId) sessionGrants.delete(relaySessionId)
      }
    }
  }
}

export class GitHubAuth extends Effect.Service<GitHubAuth>()("@jingler/GitHubAuth", {
  accessors: true,
  effect: Effect.gen(function* () {
    const secrets = yield* SecretStore
    const client = makeGitHubAuthClient({
      bearer: () => Effect.runPromise(secrets.get)
    })
    const wrap = <A>(run: () => Promise<A>): Effect.Effect<A, GitHubApiError> =>
      Effect.tryPromise({
        try: run,
        catch: (error) =>
          error instanceof GitHubApiError
            ? error
            : new GitHubApiError({
                reason: "unavailable",
                message: "The GitHub connection service could not complete the request."
              })
      })
    return {
      status: () => wrap(client.status),
      viewerLogin: () => wrap(client.viewerLogin),
      grantForInstallation: (installationId: string, scopes: ReadonlyArray<string> = []) =>
        wrap(() => client.grantForInstallation(installationId, scopes)),
      grantForOwner: (owner: string, scopes: ReadonlyArray<string> = []) =>
        wrap(() => client.grantForOwner(owner, scopes)),
      sessionRoutes: () => wrap(client.sessionRoutes),
      upsertSessionRoute: (input: {
        readonly sessionId: string
        readonly installationId: string
        readonly repositoryId: string
        readonly pullRequestNumber: number
      }) => wrap(() => client.upsertSessionRoute(input)),
      grantForSession: (relaySessionId: string) =>
        wrap(() => client.grantForSession(relaySessionId)),
      archiveSessionRoute: (relaySessionId: string) =>
        wrap(() => client.archiveSessionRoute(relaySessionId)),
      unlinkSessionRoute: (relaySessionId: string) =>
        wrap(() => client.unlinkSessionRoute(relaySessionId)),
      credentialsForInstallation: (
        installationId: string,
        repository: string,
        permissions: ReadonlyArray<string>
      ) => wrap(() => client.credentialsForInstallation(installationId, repository, permissions)),
      credentialsForOwner: (
        owner: string,
        repository: string,
        permissions: ReadonlyArray<string>
      ) => wrap(() => client.credentialsForOwner(owner, repository, permissions)),
      defaultPluginGrant: (scopes: ReadonlyArray<string>) =>
        wrap(() => client.defaultPluginGrant(scopes)),
      invalidate: (installationId: string) => Effect.sync(() => client.invalidate(installationId))
    } as const
  })
}) {}
