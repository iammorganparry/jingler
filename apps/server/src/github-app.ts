/**
 * GitHub App protocol and cryptographic boundary.
 *
 * User and refresh tokens leave this module only so the repository adapter can
 * encrypt them. Installation access tokens are returned only through the
 * trusted Electron-main credential boundary, and the database schema has no
 * column capable of storing one.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSign,
  hkdfSync,
  randomBytes
} from "node:crypto"

const API_VERSION = "2026-03-10"
const JSON_ACCEPT = "application/vnd.github+json"

export interface GitHubAppConfig {
  readonly appId: string
  readonly clientId: string
  readonly clientSecret: string
  readonly privateKey: string
  readonly relayUrl: string
  readonly relaySigningSecret: string
  readonly apiBaseUrl?: string
  readonly webBaseUrl?: string
}

export interface GitHubUserToken {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly accessTokenExpiresAt: Date | null
  readonly refreshTokenExpiresAt: Date | null
}

export interface GitHubApiUser {
  readonly id: string
  readonly login: string
  readonly name: string | null
  readonly avatarUrl: string | null
}

export interface GitHubApiInstallation {
  readonly id: string
  readonly account: {
    readonly id: string
    readonly login: string
    readonly type: string
    readonly avatarUrl: string | null
  }
  readonly repositorySelection: "all" | "selected"
  readonly permissions: Readonly<Record<string, string>>
  readonly suspendedAt: Date | null
}

export interface GitHubApiRepository {
  /** Immutable GitHub database id. */
  readonly id: string
  /** Canonical owner/repository name. */
  readonly fullName: string
}

export interface GitHubInstallationAccessToken {
  readonly token: string
  readonly expiresAt: Date
}

export type GitHubAppFailureCode =
  "invalid-response" | "oauth-rejected" | "api-rejected" | "invalid-private-key" | "invalid-grant"

/** Deliberately carries no upstream body, URL query, or credential material. */
export class GitHubAppError extends Error {
  readonly code: GitHubAppFailureCode
  readonly status: number | null

  constructor(code: GitHubAppFailureCode, status: number | null = null) {
    super(`GitHub App request failed: ${code}${status === null ? "" : ` (${status})`}`)
    this.name = "GitHubAppError"
    this.code = code
    this.status = status
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

export const createGitHubAppJwt = (
  config: Pick<GitHubAppConfig, "appId" | "privateKey">,
  nowSeconds = Math.floor(Date.now() / 1_000)
): string => {
  const header = encodeJson({ alg: "RS256", typ: "JWT" })
  // GitHub permits at most ten minutes and recommends backdating for clock skew.
  const payload = encodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: config.appId
  })
  const signed = `${header}.${payload}`
  try {
    const signer = createSign("RSA-SHA256")
    signer.update(signed)
    signer.end()
    return `${signed}.${signer.sign(config.privateKey, "base64url")}`
  } catch {
    throw new GitHubAppError("invalid-private-key")
  }
}

const string = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const expiresAt = (now: Date, seconds: unknown): Date | null => {
  const value = number(seconds)
  return value === null ? null : new Date(now.getTime() + value * 1_000)
}

const permissionsFrom = (value: unknown): Readonly<Record<string, string>> => {
  const candidate = object(value)
  if (!candidate) return {}
  return Object.fromEntries(
    Object.entries(candidate).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
}

const requestHeaders = (authorization?: string): Headers => {
  const headers = new Headers({
    Accept: JSON_ACCEPT,
    "X-GitHub-Api-Version": API_VERSION
  })
  if (authorization) headers.set("Authorization", authorization)
  return headers
}

export interface GitHubAppClient {
  readonly authorizationUrl: (state: string, codeChallenge: string) => string
  readonly installationUrl: (state: string) => Promise<string>
  readonly exchangeCode: (code: string, codeVerifier?: string) => Promise<GitHubUserToken>
  readonly refreshUserToken: (refreshToken: string) => Promise<GitHubUserToken>
  readonly getUser: (accessToken: string) => Promise<GitHubApiUser>
  readonly listInstallations: (accessToken: string) => Promise<ReadonlyArray<GitHubApiInstallation>>
  readonly listInstallationRepositories: (
    accessToken: string,
    installationId: string
  ) => Promise<ReadonlyArray<GitHubApiRepository>>
  readonly createInstallationAccessToken: (
    installationId: string,
    scope: {
      readonly permissions: Readonly<Record<string, "read" | "write">>
      readonly repositories: ReadonlyArray<string>
    }
  ) => Promise<GitHubInstallationAccessToken>
  readonly revokeUserToken: (accessToken: string) => Promise<void>
}

export const createGitHubAppClient = (
  config: GitHubAppConfig,
  dependencies: {
    readonly fetch?: typeof fetch
    readonly now?: () => Date
  } = {}
): GitHubAppClient => {
  const request = dependencies.fetch ?? fetch
  const now = dependencies.now ?? (() => new Date())
  const apiBaseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "")
  const webBaseUrl = (config.webBaseUrl ?? "https://github.com").replace(/\/$/, "")

  const json = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    const response = await request(url, init)
    if (!response.ok) throw new GitHubAppError("api-rejected", response.status)
    try {
      const body: unknown = await response.json()
      const parsed = object(body)
      if (!parsed) throw new GitHubAppError("invalid-response", response.status)
      return parsed
    } catch (error) {
      if (error instanceof GitHubAppError) throw error
      throw new GitHubAppError("invalid-response", response.status)
    }
  }

  const oauthToken = async (parameters: URLSearchParams): Promise<GitHubUserToken> => {
    const response = await request(`${webBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: parameters
    })
    if (!response.ok) throw new GitHubAppError("oauth-rejected", response.status)
    let body: Record<string, unknown>
    try {
      body = object(await response.json()) ?? {}
    } catch {
      throw new GitHubAppError("invalid-response", response.status)
    }
    const accessToken = string(body.access_token)
    if (!accessToken || body.error) throw new GitHubAppError("oauth-rejected", response.status)
    const issuedAt = now()
    return {
      accessToken,
      refreshToken: string(body.refresh_token),
      accessTokenExpiresAt: expiresAt(issuedAt, body.expires_in),
      refreshTokenExpiresAt: expiresAt(issuedAt, body.refresh_token_expires_in)
    }
  }

  const appJwt = (): string => createGitHubAppJwt(config, Math.floor(now().getTime() / 1_000))

  return {
    authorizationUrl: (state, codeChallenge) => {
      const url = new URL(`${webBaseUrl}/login/oauth/authorize`)
      url.searchParams.set("client_id", config.clientId)
      url.searchParams.set("state", state)
      url.searchParams.set("code_challenge", codeChallenge)
      url.searchParams.set("code_challenge_method", "S256")
      return url.toString()
    },

    installationUrl: async (state) => {
      const app = await json(`${apiBaseUrl}/app`, {
        headers: requestHeaders(`Bearer ${appJwt()}`)
      })
      const slug = string(app.slug)
      if (!slug) throw new GitHubAppError("invalid-response")
      const url = new URL(`${webBaseUrl}/apps/${encodeURIComponent(slug)}/installations/new`)
      url.searchParams.set("state", state)
      return url.toString()
    },

    exchangeCode: (code, codeVerifier) => {
      const parameters = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code
      })
      if (codeVerifier) parameters.set("code_verifier", codeVerifier)
      return oauthToken(parameters)
    },

    refreshUserToken: (refreshToken) =>
      oauthToken(
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken
        })
      ),

    getUser: async (accessToken) => {
      const body = await json(`${apiBaseUrl}/user`, {
        headers: requestHeaders(`Bearer ${accessToken}`)
      })
      const id = number(body.id)
      const login = string(body.login)
      if (id === null || !login) throw new GitHubAppError("invalid-response")
      return {
        id: String(id),
        login,
        name: string(body.name),
        avatarUrl: string(body.avatar_url)
      }
    },

    listInstallations: async (accessToken) => {
      const installations: Array<GitHubApiInstallation> = []
      for (let page = 1; page <= 100; page += 1) {
        const body = await json(`${apiBaseUrl}/user/installations?per_page=100&page=${page}`, {
          headers: requestHeaders(`Bearer ${accessToken}`)
        })
        const rows = Array.isArray(body.installations) ? body.installations : null
        if (!rows) throw new GitHubAppError("invalid-response")
        for (const value of rows) {
          const row = object(value)
          const account = object(row?.account)
          const id = number(row?.id)
          const accountId = number(account?.id)
          const login = string(account?.login)
          if (id === null || !account || accountId === null || !login) continue
          installations.push({
            id: String(id),
            account: {
              id: String(accountId),
              login,
              type: string(account.type) ?? "Unknown",
              avatarUrl: string(account.avatar_url)
            },
            repositorySelection: row?.repository_selection === "selected" ? "selected" : "all",
            permissions: permissionsFrom(row?.permissions),
            suspendedAt: string(row?.suspended_at) ? new Date(String(row?.suspended_at)) : null
          })
        }
        if (rows.length < 100) break
      }
      return installations
    },

    listInstallationRepositories: async (accessToken, installationId) => {
      const repositories: Array<GitHubApiRepository> = []
      for (let page = 1; page <= 100; page += 1) {
        const body = await json(
          `${apiBaseUrl}/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`,
          { headers: requestHeaders(`Bearer ${accessToken}`) }
        )
        const rows = Array.isArray(body.repositories) ? body.repositories : null
        if (!rows) throw new GitHubAppError("invalid-response")
        for (const value of rows) {
          const row = object(value)
          const id = number(row?.id)
          const fullName = string(row?.full_name)
          if (id === null || !fullName) throw new GitHubAppError("invalid-response")
          repositories.push({ id: String(id), fullName })
        }
        if (rows.length < 100) break
      }
      return repositories
    },

    createInstallationAccessToken: async (installationId, scope) => {
      const permissions = scope.permissions
      const repositories = [...new Set(scope.repositories)]
      if (Object.keys(permissions).length === 0 || repositories.length !== 1) {
        throw new GitHubAppError("invalid-grant")
      }
      const body = await json(
        `${apiBaseUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            ...Object.fromEntries(requestHeaders(`Bearer ${appJwt()}`).entries()),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ permissions, repositories })
        }
      )
      const token = string(body.token)
      const expiry = string(body.expires_at)
      if (!token || !expiry) throw new GitHubAppError("invalid-response")
      return { token, expiresAt: new Date(expiry) }
    },

    revokeUserToken: async (accessToken) => {
      const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString(
        "base64"
      )
      const response = await request(
        `${apiBaseUrl}/applications/${encodeURIComponent(config.clientId)}/token`,
        {
          method: "DELETE",
          headers: {
            ...Object.fromEntries(requestHeaders(`Basic ${credentials}`).entries()),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ access_token: accessToken })
        }
      )
      if (!(response.ok || response.status === 404 || response.status === 401)) {
        throw new GitHubAppError("api-rejected", response.status)
      }
    }
  }
}

/** Versioned authenticated encryption for persisted GitHub user credentials. */
export interface GitHubTokenCipher {
  readonly encrypt: (plaintext: string) => string
  readonly decrypt: (envelope: string) => string
}

interface TokenEncryptionKey {
  readonly id: string
  readonly current: Buffer
  readonly legacy: Buffer
}

const tokenEncryptionKey = (rootSecret: string): TokenEncryptionKey => ({
  id: createHash("sha256").update(rootSecret).digest("base64url").slice(0, 12),
  current: Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(rootSecret, "utf8"),
      Buffer.from("jingler-github-app", "utf8"),
      Buffer.from("user-token-encryption-v2", "utf8"),
      32
    )
  ),
  legacy: Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(rootSecret, "utf8"),
      Buffer.from("jingler-github-app", "utf8"),
      Buffer.from("user-token-encryption-v1", "utf8"),
      32
    )
  )
})

const decryptEnvelope = (
  key: Buffer,
  encodedIv: string,
  encodedTag: string,
  encodedCiphertext: string
): string => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encodedIv, "base64url"))
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final()
  ]).toString("utf8")
}

export const createGitHubTokenCipher = (
  currentRootSecret: string,
  previousRootSecret?: string
): GitHubTokenCipher => {
  if (!currentRootSecret) throw new GitHubAppError("invalid-response")
  const current = tokenEncryptionKey(currentRootSecret)
  const keys = [current, ...(previousRootSecret ? [tokenEncryptionKey(previousRootSecret)] : [])]
  return {
    encrypt: (plaintext) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", current.current, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      return [
        "v2",
        current.id,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url")
      ].join(".")
    },
    decrypt: (envelope) => {
      const parts = envelope.split(".")
      const candidates: ReadonlyArray<{
        readonly key: Buffer
        readonly offset: number
      }> =
        parts[0] === "v2" && parts.length === 5 && parts[1]
          ? keys
              .filter((key) => key.id === parts[1])
              .map((key) => ({ key: key.current, offset: 2 }))
          : parts[0] === "v1" && parts.length === 4
            ? keys.map((key) => ({ key: key.legacy, offset: 1 }))
            : []
      for (const candidate of candidates) {
        const encodedIv = parts[candidate.offset]
        const encodedTag = parts[candidate.offset + 1]
        const encodedCiphertext = parts[candidate.offset + 2]
        if (!encodedIv || !encodedTag || !encodedCiphertext) continue
        try {
          return decryptEnvelope(candidate.key, encodedIv, encodedTag, encodedCiphertext)
        } catch {
          // Try the previous key during the explicit rotation window.
        }
      }
      throw new GitHubAppError("invalid-response")
    }
  }
}

export const hashGitHubCallbackState = (state: string): string =>
  createHash("sha256").update(state).digest("hex")

export const createGitHubPkce = (): {
  readonly verifier: string
  readonly challenge: string
} => {
  const verifier = randomBytes(48).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url")
  }
}

export { issueGitHubDesktopGrant, verifyGitHubDesktopGrant } from "./github-relay-grant.js"
