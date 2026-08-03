import {
  MemoryGrantClaims,
  type MemoryGrantResponse,
  type MemoryPrivilege
} from "@jingler/core"
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { Schema } from "effect"
import type { OrganizationAuthorization } from "./db/repositories/organization-repository.js"

export interface MemoryGrantConfig {
  readonly secret: string
  readonly audience: string
  readonly ttlSeconds: number
}

export interface VerifyMemoryGrantOptions {
  readonly secret: string
  readonly audience: string
  readonly organizationId: string
  readonly nowSeconds?: number
}

export type MemoryGrantFailureReason =
  | "malformed"
  | "altered"
  | "expired"
  | "wrong-audience"
  | "wrong-organization"

export class MemoryGrantError extends Error {
  readonly reason: MemoryGrantFailureReason

  constructor(reason: MemoryGrantFailureReason) {
    super(`Memory grant rejected: ${reason}`)
    this.name = "MemoryGrantError"
    this.reason = reason
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

const sign = (value: string, secret: string): string =>
  createHmac("sha256", secret).update(value).digest("base64url")

export const issueMemoryGrant = (
  input: {
    readonly subject: string
    readonly organizationId: string
    readonly privileges: ReadonlyArray<MemoryPrivilege>
  },
  config: MemoryGrantConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId: string = randomUUID()
): MemoryGrantResponse => {
  const claims = Schema.decodeUnknownSync(MemoryGrantClaims)({
    version: 1,
    issuer: "jingler",
    audience: config.audience,
    subject: input.subject,
    organizationId: input.organizationId,
    privileges: [...input.privileges],
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + config.ttlSeconds,
    grantId
  })
  const header = encodeJson({ algorithm: "HS256", type: "JinglerMemoryGrant", version: 1 })
  const payload = encodeJson(claims)
  const signed = `${header}.${payload}`
  return { grant: `${signed}.${sign(signed, config.secret)}`, claims }
}

const safeSignatureMatch = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual, "utf8")
  const expectedBytes = Buffer.from(expected, "utf8")
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

const MemoryGrantHeader = Schema.Struct({
  algorithm: Schema.Literal("HS256"),
  type: Schema.Literal("JinglerMemoryGrant"),
  version: Schema.Literal(1)
})

const MemoryGrantRequest = Schema.Struct({
  organizationId: Schema.String.pipe(Schema.minLength(1))
})

export const verifyMemoryGrant = (
  grant: string,
  options: VerifyMemoryGrantOptions
): MemoryGrantResponse["claims"] => {
  const parts = grant.split(".")
  const header = parts[0]
  const payload = parts[1]
  const signature = parts[2]
  if (!(header && payload && signature) || parts.length !== 3) {
    throw new MemoryGrantError("malformed")
  }
  const signed = `${header}.${payload}`
  if (!safeSignatureMatch(signature, sign(signed, options.secret))) {
    throw new MemoryGrantError("altered")
  }

  try {
    Schema.decodeUnknownSync(Schema.parseJson(MemoryGrantHeader))(
      Buffer.from(header, "base64url").toString("utf8")
    )
  } catch {
    throw new MemoryGrantError("malformed")
  }

  let claims: MemoryGrantResponse["claims"]
  try {
    claims = Schema.decodeUnknownSync(Schema.parseJson(MemoryGrantClaims))(
      Buffer.from(payload, "base64url").toString("utf8")
    )
  } catch {
    throw new MemoryGrantError("malformed")
  }
  if (claims.audience !== options.audience) throw new MemoryGrantError("wrong-audience")
  if (claims.organizationId !== options.organizationId) {
    throw new MemoryGrantError("wrong-organization")
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (claims.expiresAt <= now) throw new MemoryGrantError("expired")
  return claims
}

export interface MemoryGrantHandlerDependencies {
  readonly getUserId: (headers: Headers) => Promise<string | null>
  readonly authorize: (
    userId: string,
    organizationId: string
  ) => Promise<OrganizationAuthorization | null>
  readonly issue: (
    userId: string,
    authorization: OrganizationAuthorization
  ) => MemoryGrantResponse
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

const requestedGrant = async (
  request: Request
): Promise<{ readonly organizationId: string } | null> => {
  try {
    const body = Schema.decodeUnknownSync(MemoryGrantRequest)(await request.json())
    return { organizationId: body.organizationId }
  } catch {
    return null
  }
}

export const handleMemoryGrantRequest = async (
  request: Request,
  dependencies: MemoryGrantHandlerDependencies
): Promise<Response> => {
  const userId = await dependencies.getUserId(request.headers)
  if (!userId) return json({ error: "Authentication required" }, 401)
  const requested = await requestedGrant(request)
  if (!requested) return json({ error: "organizationId is required" }, 400)
  const authorization = await dependencies.authorize(userId, requested.organizationId)
  if (!authorization) return json({ error: "Paid organization membership required" }, 403)
  return json(dependencies.issue(userId, authorization), 200)
}
