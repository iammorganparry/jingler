import {
  OFFLOAD_GRANT_MAX_TTL_SECONDS,
  OffloadAdmissionError,
  OffloadGrantClaims,
  type OffloadGrantAction,
  type OffloadGrantClaims as OffloadGrantClaimsValue
} from "@jingler/core"
import { Effect, Either, Schema } from "effect"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const BASE64_PADDING = /[=]+$/u

export type OffloadGrantRejection =
  | "missing"
  | "malformed"
  | "invalid-signature"
  | "invalid-claims"
  | "expired"
  | "overlong"
  | "future-issued"
  | "wrong-scope"
  | "action-denied"
  | "replayed"

export type OffloadGrantVerification =
  | { readonly ok: true; readonly claims: OffloadGrantClaimsValue }
  | { readonly ok: false; readonly reason: OffloadGrantRejection }

export interface IssueOffloadGrantInput {
  readonly subject: string
  readonly sessionId: string
  readonly jobId: string
  readonly idempotencyKey: string
  readonly repositorySlug: string
  readonly snapshotDigest: string
  readonly actions: ReadonlyArray<OffloadGrantAction>
}

export interface VerifyOffloadGrantExpected {
  readonly action: OffloadGrantAction
  readonly subject: string
  readonly sessionId: string
  readonly jobId: string
  readonly repositorySlug: string
  readonly snapshotDigest: string
  readonly consumedGrantIds?: ReadonlySet<string>
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING, "")
}

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

const encodeJson = (value: object): string =>
  base64Url(encoder.encode(JSON.stringify(value)))

const hmacKey = (
  secret: string,
  usage: ReadonlyArray<"sign" | "verify">
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [...usage]
  )

const admissionFailure = (): OffloadAdmissionError =>
  new OffloadAdmissionError({
    reason: "unavailable",
    message: "Offload grant could not be issued"
  })

export const issueOffloadGrant = (
  input: IssueOffloadGrantInput,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId = `grant_${crypto.randomUUID().replaceAll("-", "")}`
): Effect.Effect<
  { readonly grant: string; readonly claims: OffloadGrantClaimsValue },
  OffloadAdmissionError
> =>
  Effect.tryPromise({
    try: async () => {
      if (secret.length < 32) throw new Error("Invalid signing configuration")
      const claims = Schema.decodeUnknownSync(OffloadGrantClaims)({
        version: 1,
        issuer: "jingler",
        audience: "offload-compute",
        grantId,
        ...input,
        actions: [...new Set(input.actions)],
        issuedAt: nowSeconds,
        expiresAt: nowSeconds + OFFLOAD_GRANT_MAX_TTL_SECONDS
      })
      const header = encodeJson({ alg: "HS256", typ: "JinglerOffloadGrant", version: 1 })
      const payload = encodeJson(claims)
      const signed = `${header}.${payload}`
      const signature = await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secret, ["sign"]),
        encoder.encode(signed)
      )
      return {
        grant: `${signed}.${base64Url(new Uint8Array(signature))}`,
        claims
      }
    },
    catch: admissionFailure
  })

const matchesScope = (
  claims: OffloadGrantClaimsValue,
  expected: VerifyOffloadGrantExpected
): boolean =>
  claims.subject === expected.subject &&
  claims.sessionId === expected.sessionId &&
  claims.jobId === expected.jobId &&
  claims.repositorySlug === expected.repositorySlug &&
  claims.snapshotDigest === expected.snapshotDigest

const tokenParts = (
  grant: string,
  secret: string
): readonly [string, string, string] | null => {
  const parts = grant.split(".")
  const [header, payload, signature] = parts
  return header && payload && signature && parts.length === 3 && secret.length >= 32
    ? [header, payload, signature]
    : null
}

const verifyUnsafe = async (
  grant: string | null,
  secret: string,
  expected: VerifyOffloadGrantExpected,
  nowSeconds: number
): Promise<OffloadGrantVerification> => {
  if (grant === null) return { ok: false, reason: "missing" }
  const parts = tokenParts(grant, secret)
  if (parts === null) return { ok: false, reason: "malformed" }
  const [header, payload, signature] = parts
  const signed = `${header}.${payload}`
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    decodeBase64Url(signature),
    encoder.encode(signed)
  )
  if (!signatureValid) return { ok: false, reason: "invalid-signature" }
  const headerValue: unknown = JSON.parse(decoder.decode(decodeBase64Url(header)))
  const headerFields =
    typeof headerValue === "object" && headerValue !== null
      ? Object.fromEntries(Object.entries(headerValue))
      : null
  if (
    headerFields?.alg !== "HS256" ||
    headerFields.typ !== "JinglerOffloadGrant" ||
    headerFields.version !== 1
  ) {
    return { ok: false, reason: "malformed" }
  }
  const decoded = Schema.decodeUnknownEither(OffloadGrantClaims)(
    JSON.parse(decoder.decode(decodeBase64Url(payload))),
    { onExcessProperty: "error" }
  )
  if (Either.isLeft(decoded)) return { ok: false, reason: "invalid-claims" }
  const claims = decoded.right
  if (claims.expiresAt <= nowSeconds) return { ok: false, reason: "expired" }
  if (claims.issuedAt > nowSeconds + 60) return { ok: false, reason: "future-issued" }
  if (claims.expiresAt - claims.issuedAt > OFFLOAD_GRANT_MAX_TTL_SECONDS) {
    return { ok: false, reason: "overlong" }
  }
  if (expected.consumedGrantIds?.has(claims.grantId)) {
    return { ok: false, reason: "replayed" }
  }
  if (!claims.actions.includes(expected.action)) {
    return { ok: false, reason: "action-denied" }
  }
  if (!matchesScope(claims, expected)) {
    return { ok: false, reason: "wrong-scope" }
  }
  return { ok: true, claims }
}

export const verifyOffloadGrant = (
  grant: string | null,
  secret: string,
  expected: VerifyOffloadGrantExpected,
  nowSeconds = Math.floor(Date.now() / 1_000)
): Effect.Effect<OffloadGrantVerification> =>
  Effect.tryPromise(() => verifyUnsafe(grant, secret, expected, nowSeconds)).pipe(
    Effect.catchAll(() => Effect.succeed({ ok: false, reason: "malformed" } as const))
  )

export const bearerOffloadGrant = (request: Request): string | null => {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null
  const grant = authorization.slice("Bearer ".length).trim()
  return grant.length === 0 ? null : grant
}
