import type {
  GitHubDesktopGrantClaims,
  GitHubDesktopGrantResponse,
  GitHubSessionRelayGrantClaims,
  GitHubSessionRelayGrantResponse
} from "@jingler/core"
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"

export interface GitHubRelayGrantConfig {
  readonly relayUrl: string
  readonly relaySigningSecret: string
  readonly ttlSeconds?: number
}

export class GitHubRelayGrantError extends Error {
  constructor() {
    super("GitHub relay grant rejected: invalid-grant")
    this.name = "GitHubRelayGrantError"
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

const sign = (signed: string, secret: string): string =>
  createHmac("sha256", secret).update(signed).digest("base64url")

const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

/** Mint a five-minute, installation-scoped relay credential; it contains no GitHub token. */
export const issueGitHubRelayGrant = (
  input: { readonly userId: string; readonly installationId: string },
  config: GitHubRelayGrantConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId: string = randomUUID()
): GitHubDesktopGrantResponse => {
  const claims: GitHubDesktopGrantClaims = {
    version: 1,
    issuer: "jingler",
    audience: "jingler-github-relay",
    subject: input.userId,
    installationId: input.installationId,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + (config.ttlSeconds ?? 300),
    grantId
  }
  const header = encodeJson({ alg: "HS256", typ: "JinglerGitHubGrant", version: 1 })
  const payload = encodeJson(claims)
  const signed = `${header}.${payload}`
  return {
    relayUrl: config.relayUrl,
    grant: `${signed}.${sign(signed, config.relaySigningSecret)}`,
    claims
  }
}

export const verifyGitHubRelayGrant = (
  grant: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000)
): GitHubDesktopGrantClaims => {
  const parts = grant.split(".")
  const headerPart = parts[0]
  const payloadPart = parts[1]
  const signature = parts[2]
  if (!headerPart || !payloadPart || !signature || parts.length !== 3) {
    throw new GitHubRelayGrantError()
  }
  const signed = `${headerPart}.${payloadPart}`
  if (!safeEqual(signature, sign(signed, secret))) throw new GitHubRelayGrantError()
  try {
    const header = object(JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")))
    const claims = object(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")))
    if (
      header?.alg !== "HS256" ||
      header.typ !== "JinglerGitHubGrant" ||
      header.version !== 1 ||
      claims?.version !== 1 ||
      claims.issuer !== "jingler" ||
      claims.audience !== "jingler-github-relay" ||
      !string(claims.subject) ||
      !string(claims.installationId) ||
      !/^\d+$/.test(claims.installationId) ||
      !integer(claims.issuedAt) ||
      !integer(claims.expiresAt) ||
      !string(claims.grantId) ||
      claims.issuedAt > nowSeconds + 60 ||
      claims.expiresAt <= nowSeconds
    ) {
      throw new GitHubRelayGrantError()
    }
    return {
      version: 1,
      issuer: "jingler",
      audience: "jingler-github-relay",
      subject: claims.subject,
      installationId: claims.installationId,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      grantId: claims.grantId
    }
  } catch (error) {
    if (error instanceof GitHubRelayGrantError) throw error
    throw new GitHubRelayGrantError()
  }
}

/** Mint a five-minute credential scoped to exactly one linked session stream. */
export const issueGitHubSessionRelayGrant = (
  input: {
    readonly userId: string
    readonly installationId: string
    readonly relaySessionId: string
  },
  config: GitHubRelayGrantConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId: string = randomUUID()
): GitHubSessionRelayGrantResponse => {
  const claims: GitHubSessionRelayGrantClaims = {
    version: 1,
    issuer: "jingler",
    audience: "jingler-github-relay",
    subject: input.userId,
    installationId: input.installationId,
    relaySessionId: input.relaySessionId,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + (config.ttlSeconds ?? 300),
    grantId
  }
  const header = encodeJson({ alg: "HS256", typ: "JinglerGitHubGrant", version: 1 })
  const payload = encodeJson(claims)
  const signed = `${header}.${payload}`
  return {
    relayUrl: config.relayUrl,
    grant: `${signed}.${sign(signed, config.relaySigningSecret)}`,
    claims
  }
}

export const verifyGitHubSessionRelayGrant = (
  grant: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000)
): GitHubSessionRelayGrantClaims => {
  const base = verifyGitHubRelayGrant(grant, secret, nowSeconds)
  try {
    const payloadPart = grant.split(".")[1]
    if (!payloadPart) throw new GitHubRelayGrantError()
    const claims = object(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")))
    if (!string(claims?.relaySessionId) || !/^[A-Za-z0-9_-]{20,128}$/.test(claims.relaySessionId)) {
      throw new GitHubRelayGrantError()
    }
    return { ...base, relaySessionId: claims.relaySessionId }
  } catch (error) {
    if (error instanceof GitHubRelayGrantError) throw error
    throw new GitHubRelayGrantError()
  }
}

/** Compatibility names for the already-shipped desktop-grant route and callers. */
export const issueGitHubDesktopGrant = (
  input: { readonly userId: string; readonly installationId: string },
  config: Omit<GitHubRelayGrantConfig, "ttlSeconds">,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId: string = randomUUID(),
  ttlSeconds = 300
): GitHubDesktopGrantResponse =>
  issueGitHubRelayGrant(input, { ...config, ttlSeconds }, nowSeconds, grantId)
export const verifyGitHubDesktopGrant = verifyGitHubRelayGrant
