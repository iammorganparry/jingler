import type {
  ManagedRuntimeAction,
  ManagedRuntimeGrantClaims
} from "@jingler/core"
import {
  MANAGED_RUNTIME_GRANT_MAX_TTL_SECONDS,
  ManagedRuntimeGrantClaims as ManagedRuntimeGrantClaimsSchema
} from "@jingler/core"
import { Either, Schema } from "effect"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type ManagedGrantRejection =
  | "missing"
  | "malformed"
  | "invalid-signature"
  | "invalid-claims"
  | "expired"
  | "overlong"
  | "future-issued"
  | "wrong-auth-version"
  | "stale-environment"
  | "stale-session"
  | "wrong-scope"
  | "action-denied"

export type ManagedGrantVerification =
  | { readonly ok: true; readonly claims: ManagedRuntimeGrantClaims }
  | { readonly ok: false; readonly reason: ManagedGrantRejection }

export interface IssueManagedRuntimeGrantInput {
  readonly subject: string
  readonly environmentId: string
  readonly sessionId: string
  readonly actions: readonly ManagedRuntimeAction[]
  readonly authStateVersion: number
  readonly environmentGeneration: number
  readonly sessionGeneration: number
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

const encodeJson = (value: unknown): string =>
  base64Url(encoder.encode(JSON.stringify(value)))

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

const hmacKey = (
  secret: string,
  usage: Array<"sign" | "verify">
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage
  )

export const issueManagedRuntimeGrant = async (
  input: IssueManagedRuntimeGrantInput,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId = `grant_${crypto.randomUUID().replaceAll("-", "")}`
): Promise<{ grant: string; claims: ManagedRuntimeGrantClaims }> => {
  if (secret.length < 32) throw new Error("Managed runtime grant secret is invalid")
  const claims = Schema.decodeUnknownSync(ManagedRuntimeGrantClaimsSchema)({
    version: 1,
    issuer: "jingler",
    audience: "managed-runtime",
    grantId,
    ...input,
    actions: [...new Set(input.actions)],
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + MANAGED_RUNTIME_GRANT_MAX_TTL_SECONDS
  })
  const header = encodeJson({ alg: "HS256", typ: "JinglerManagedGrant", version: 1 })
  const payload = encodeJson(claims)
  const signed = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, ["sign"]),
    encoder.encode(signed)
  )
  return { grant: `${signed}.${base64Url(new Uint8Array(signature))}`, claims }
}

export const verifyManagedRuntimeGrant = async (
  grant: string | null,
  secret: string,
  expected: {
    readonly action: ManagedRuntimeAction
    readonly authStateVersion: number
    readonly environmentGeneration: number
    readonly sessionGeneration: number
    readonly subject?: string
    readonly environmentId?: string
    readonly sessionId?: string
  },
  nowSeconds = Math.floor(Date.now() / 1_000)
): Promise<ManagedGrantVerification> => {
  if (grant === null) return { ok: false, reason: "missing" }
  const parts = grant.split(".")
  const header = parts[0]
  const payload = parts[1]
  const signature = parts[2]
  if (!header || !payload || !signature || parts.length !== 3 || secret.length < 32) {
    return { ok: false, reason: "malformed" }
  }
  try {
    const signed = `${header}.${payload}`
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      decodeBase64Url(signature),
      encoder.encode(signed)
    )
    if (!valid) return { ok: false, reason: "invalid-signature" }
    const headerValue: unknown = JSON.parse(decoder.decode(decodeBase64Url(header)))
    const headerFields =
      typeof headerValue === "object" && headerValue !== null
        ? Object.fromEntries(Object.entries(headerValue))
        : null
    if (
      headerFields?.alg !== "HS256" ||
      headerFields.typ !== "JinglerManagedGrant" ||
      headerFields.version !== 1
    ) {
      return { ok: false, reason: "malformed" }
    }
    const decoded = Schema.decodeUnknownEither(ManagedRuntimeGrantClaimsSchema)(
      JSON.parse(decoder.decode(decodeBase64Url(payload))),
      { onExcessProperty: "error" }
    )
    if (Either.isLeft(decoded)) return { ok: false, reason: "invalid-claims" }
    const claims = decoded.right
    if (claims.expiresAt <= nowSeconds) return { ok: false, reason: "expired" }
    if (claims.issuedAt > nowSeconds + 60) return { ok: false, reason: "future-issued" }
    if (claims.expiresAt - claims.issuedAt > MANAGED_RUNTIME_GRANT_MAX_TTL_SECONDS) {
      return { ok: false, reason: "overlong" }
    }
    if (claims.authStateVersion !== expected.authStateVersion) {
      return { ok: false, reason: "wrong-auth-version" }
    }
    if (claims.environmentGeneration !== expected.environmentGeneration) {
      return { ok: false, reason: "stale-environment" }
    }
    if (claims.sessionGeneration !== expected.sessionGeneration) {
      return { ok: false, reason: "stale-session" }
    }
    if (!claims.actions.includes(expected.action)) {
      return { ok: false, reason: "action-denied" }
    }
    if (
      (expected.subject !== undefined && claims.subject !== expected.subject) ||
      (expected.environmentId !== undefined &&
        claims.environmentId !== expected.environmentId) ||
      (expected.sessionId !== undefined && claims.sessionId !== expected.sessionId)
    ) {
      return { ok: false, reason: "wrong-scope" }
    }
    return { ok: true, claims }
  } catch {
    return { ok: false, reason: "malformed" }
  }
}

export const bearerManagedGrant = (request: Request): string | null => {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null
  const grant = authorization.slice("Bearer ".length).trim()
  return grant.length === 0 ? null : grant
}
