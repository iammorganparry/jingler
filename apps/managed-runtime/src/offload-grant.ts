import {
  OFFLOAD_GRANT_MAX_TTL_SECONDS,
  OffloadAdmissionError,
  OffloadGrantClaims,
  type OffloadGrantAction,
  type OffloadGrantClaims as OffloadGrantClaimsValue
} from "@jingler/core"
import { Effect, Either, Schema } from "effect"
import { errors as joseErrors, jwtVerify, SignJWT } from "jose"

const encoder = new TextEncoder()
const JWT_ISSUER = "jingler"
const JWT_AUDIENCE = "offload-compute"
const JWT_TYPE = "JinglerOffloadGrant"

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
  readonly subject?: string
  readonly sessionId?: string
  readonly jobId?: string
  readonly repositorySlug?: string
  readonly snapshotDigest?: string
  readonly consumedGrantIds?: ReadonlySet<string>
}

const signingKey = (secret: string): Uint8Array => {
  if (secret.length < 32) throw new Error("Invalid signing configuration")
  return encoder.encode(secret)
}

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
      const claims = Schema.decodeUnknownSync(OffloadGrantClaims)({
        version: 1,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        grantId,
        ...input,
        actions: [...new Set(input.actions)],
        issuedAt: nowSeconds,
        expiresAt: nowSeconds + OFFLOAD_GRANT_MAX_TTL_SECONDS
      })
      const grant = await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: JWT_TYPE })
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setJti(grantId)
        .setIssuedAt(nowSeconds)
        .setExpirationTime(claims.expiresAt)
        .sign(signingKey(secret))
      return { grant, claims }
    },
    catch: admissionFailure
  })

const matchesScope = (
  claims: OffloadGrantClaimsValue,
  expected: VerifyOffloadGrantExpected
): boolean =>
  (expected.subject === undefined || claims.subject === expected.subject) &&
  (expected.sessionId === undefined || claims.sessionId === expected.sessionId) &&
  (expected.jobId === undefined || claims.jobId === expected.jobId) &&
  (expected.repositorySlug === undefined || claims.repositorySlug === expected.repositorySlug) &&
  (expected.snapshotDigest === undefined || claims.snapshotDigest === expected.snapshotDigest)

const verifyUnsafe = async (
  grant: string | null,
  secret: string,
  expected: VerifyOffloadGrantExpected,
  nowSeconds: number
): Promise<OffloadGrantVerification> => {
  if (grant === null) return { ok: false, reason: "missing" }
  let payload: unknown
  try {
    const verified = await jwtVerify(grant, signingKey(secret), {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      typ: JWT_TYPE,
      currentDate: new Date(nowSeconds * 1_000),
      clockTolerance: 60
    })
    payload = verified.payload
  } catch (cause) {
    if (cause instanceof joseErrors.JWTExpired) return { ok: false, reason: "expired" }
    if (cause instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: "invalid-signature" }
    }
    return { ok: false, reason: "malformed" }
  }
  const decoded = Schema.decodeUnknownEither(OffloadGrantClaims)(payload, {
    onExcessProperty: "ignore"
  })
  if (Either.isLeft(decoded)) return { ok: false, reason: "invalid-claims" }
  const claims = decoded.right
  if (claims.expiresAt <= nowSeconds) return { ok: false, reason: "expired" }
  if (claims.issuedAt > nowSeconds + 60) return { ok: false, reason: "future-issued" }
  if (claims.expiresAt - claims.issuedAt > OFFLOAD_GRANT_MAX_TTL_SECONDS) {
    return { ok: false, reason: "overlong" }
  }
  if (
    expected.consumedGrantIds?.has(claims.grantId) ||
    expected.consumedGrantIds?.has(`${claims.grantId}:${expected.action}`)
  ) {
    return { ok: false, reason: "replayed" }
  }
  if (!claims.actions.includes(expected.action)) {
    return { ok: false, reason: "action-denied" }
  }
  if (!matchesScope(claims, expected)) return { ok: false, reason: "wrong-scope" }
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
