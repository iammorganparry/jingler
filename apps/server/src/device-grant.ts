import type {
  DeviceClaim,
  DeviceRelayGrantAudience,
  DeviceRelayGrantClaims,
  DeviceRelayGrantResponse
} from "@jingler/core"
import {
  DeviceClaim as DeviceClaimSchema,
  DeviceRelayGrantClaims as DeviceRelayGrantClaimsSchema,
  REMOTE_GRANT_MAX_TTL_SECONDS,
  deviceRelayGrantWindowRejection,
  isValidDeviceRelayGrantScope
} from "@jingler/core"
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Schema } from "effect"

export interface DeviceGrantConfig {
  readonly relayUrl: string
  readonly signingSecret: string
  readonly ttlSeconds: number
}

export interface IssueDeviceGrantInput {
  readonly audience: DeviceRelayGrantAudience
  readonly subject: string
  readonly deviceId: string | null
  readonly sessionId: string | null
  readonly clientInstanceId: string | null
  readonly attachmentGeneration: number | null
  readonly controllerLeaseGeneration: number | null
  readonly deviceGeneration: number | null
}

export interface IssueDeviceClaimInput {
  readonly subject: string
  readonly deviceId: string
  readonly clientInstanceId: string
}

export interface IssuedDeviceClaim {
  readonly claim: DeviceClaim
  readonly token: string
}

export class DeviceGrantError extends Error {
  constructor() {
    super("Device relay grant rejected: invalid-grant")
    this.name = "DeviceGrantError"
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

const sign = (value: string, secret: string): string =>
  createHmac("sha256", secret).update(value).digest("base64url")

const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

const signedToken = (type: string, payload: unknown, secret: string): string => {
  const header = encodeJson({ alg: "HS256", typ: type, version: 1 })
  const encodedPayload = encodeJson(payload)
  const signed = `${header}.${encodedPayload}`
  return `${signed}.${sign(signed, secret)}`
}

export const issueDeviceClaim = (
  input: IssueDeviceClaimInput,
  config: Pick<DeviceGrantConfig, "signingSecret" | "ttlSeconds">,
  nowSeconds = Math.floor(Date.now() / 1_000),
  claimId: string = randomUUID(),
  oneTimeSecret: string = randomBytes(32).toString("base64url")
): IssuedDeviceClaim => {
  if (
    !Number.isSafeInteger(config.ttlSeconds) ||
    config.ttlSeconds <= 0 ||
    config.ttlSeconds > REMOTE_GRANT_MAX_TTL_SECONDS
  ) {
    throw new DeviceGrantError()
  }
  const claim = Schema.decodeUnknownSync(DeviceClaimSchema)({
    version: 1,
    claimId,
    subject: input.subject,
    deviceId: input.deviceId,
    clientInstanceId: input.clientInstanceId,
    audience: "device-claim",
    oneTimeSecret,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + config.ttlSeconds
  })
  return {
    claim,
    token: signedToken("JinglerDeviceClaim", claim, config.signingSecret)
  }
}

export const issueDeviceGrant = (
  input: IssueDeviceGrantInput,
  config: DeviceGrantConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId: string = randomUUID()
): DeviceRelayGrantResponse => {
  if (
    !isValidDeviceRelayGrantScope(input) ||
    !Number.isSafeInteger(config.ttlSeconds) ||
    config.ttlSeconds <= 0 ||
    config.ttlSeconds > REMOTE_GRANT_MAX_TTL_SECONDS
  ) {
    throw new DeviceGrantError()
  }
  const claims = Schema.decodeUnknownSync(DeviceRelayGrantClaimsSchema)({
    version: 1,
    issuer: "jingler",
    audience: input.audience,
    subject: input.subject,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    clientInstanceId: input.clientInstanceId,
    attachmentGeneration: input.attachmentGeneration,
    controllerLeaseGeneration: input.controllerLeaseGeneration,
    deviceGeneration: input.deviceGeneration,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + config.ttlSeconds,
    grantId
  })
  return {
    version: 1,
    relayUrl: config.relayUrl,
    grant: signedToken("JinglerDeviceGrant", claims, config.signingSecret),
    claims
  }
}

export const verifyDeviceClaim = (
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000)
): DeviceClaim => {
  const parts = token.split(".")
  const headerPart = parts[0]
  const payloadPart = parts[1]
  const signature = parts[2]
  if (!headerPart || !payloadPart || !signature || parts.length !== 3)
    throw new DeviceGrantError()
  const signed = `${headerPart}.${payloadPart}`
  if (!safeEqual(signature, sign(signed, secret))) throw new DeviceGrantError()
  try {
    const header: unknown = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8")
    )
    if (!header || typeof header !== "object" || Array.isArray(header))
      throw new DeviceGrantError()
    const fields = Object.fromEntries(Object.entries(header))
    if (
      fields.alg !== "HS256" ||
      fields.typ !== "JinglerDeviceClaim" ||
      fields.version !== 1
    ) {
      throw new DeviceGrantError()
    }
    const claim = Schema.decodeUnknownSync(Schema.parseJson(DeviceClaimSchema))(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    )
    if (
      claim.expiresAt <= nowSeconds ||
      claim.issuedAt > nowSeconds + 60 ||
      claim.expiresAt - claim.issuedAt > REMOTE_GRANT_MAX_TTL_SECONDS
    ) {
      throw new DeviceGrantError()
    }
    return claim
  } catch (error) {
    if (error instanceof DeviceGrantError) throw error
    throw new DeviceGrantError()
  }
}

export const verifyDeviceGrant = (
  grant: string,
  secret: string,
  expectedAudience: DeviceRelayGrantAudience,
  nowSeconds = Math.floor(Date.now() / 1_000)
): DeviceRelayGrantClaims => {
  const parts = grant.split(".")
  const headerPart = parts[0]
  const payloadPart = parts[1]
  const signature = parts[2]
  if (!headerPart || !payloadPart || !signature || parts.length !== 3) throw new DeviceGrantError()
  const signed = `${headerPart}.${payloadPart}`
  if (!safeEqual(signature, sign(signed, secret))) throw new DeviceGrantError()
  try {
    const header: unknown = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"))
    if (!header || typeof header !== "object" || Array.isArray(header)) throw new DeviceGrantError()
    const fields = Object.fromEntries(Object.entries(header))
    if (fields.alg !== "HS256" || fields.typ !== "JinglerDeviceGrant" || fields.version !== 1) {
      throw new DeviceGrantError()
    }
    const claims = Schema.decodeUnknownSync(Schema.parseJson(DeviceRelayGrantClaimsSchema))(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    )
    if (
      claims.audience !== expectedAudience ||
      deviceRelayGrantWindowRejection(claims, nowSeconds) !== null ||
      !isValidDeviceRelayGrantScope(claims)
    ) {
      throw new DeviceGrantError()
    }
    return claims
  } catch (error) {
    if (error instanceof DeviceGrantError) throw error
    throw new DeviceGrantError()
  }
}
