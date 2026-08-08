import type {
  DeviceRelayGrantAudience,
  DeviceRelayGrantClaims,
  DeviceRelayGrantResponse
} from "@jingler/core"
import {
  DeviceRelayGrantClaims as DeviceRelayGrantClaimsSchema,
  REMOTE_GRANT_MAX_TTL_SECONDS
} from "@jingler/core"
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
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
  readonly deviceGeneration: number | null
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

const validScope = (input: IssueDeviceGrantInput): boolean => {
  switch (input.audience) {
    case "device-control":
      return input.sessionId === null && input.deviceGeneration === null
    case "device-challenge":
      return input.deviceId !== null && input.sessionId === null && input.deviceGeneration === null
    case "device-connect":
      return (
        input.deviceId !== null && input.sessionId === null && input.deviceGeneration !== null
      )
    case "session-tunnel":
      return (
        input.deviceId !== null && input.sessionId !== null && input.deviceGeneration !== null
      )
  }
}

export const issueDeviceGrant = (
  input: IssueDeviceGrantInput,
  config: DeviceGrantConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
  grantId: string = randomUUID()
): DeviceRelayGrantResponse => {
  if (
    !validScope(input) ||
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
    deviceGeneration: input.deviceGeneration,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + config.ttlSeconds,
    grantId
  })
  const header = encodeJson({ alg: "HS256", typ: "JinglerDeviceGrant", version: 1 })
  const payload = encodeJson(claims)
  const signed = `${header}.${payload}`
  return {
    version: 1,
    relayUrl: config.relayUrl,
    grant: `${signed}.${sign(signed, config.signingSecret)}`,
    claims
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
      claims.expiresAt <= nowSeconds ||
      claims.expiresAt - claims.issuedAt > REMOTE_GRANT_MAX_TTL_SECONDS ||
      claims.issuedAt > nowSeconds + 60 ||
      !validScope(claims)
    ) {
      throw new DeviceGrantError()
    }
    return claims
  } catch (error) {
    if (error instanceof DeviceGrantError) throw error
    throw new DeviceGrantError()
  }
}
