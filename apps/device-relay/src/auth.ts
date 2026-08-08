import type { DeviceRelayGrantAudience, DeviceRelayGrantClaims } from "@jingler/core"
import {
  DeviceRelayGrantClaims as DeviceRelayGrantClaimsSchema,
  REMOTE_GRANT_MAX_TTL_SECONDS
} from "@jingler/core"
import { Either, Schema } from "effect"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type GrantRejectionReason =
  | "missing"
  | "malformed"
  | "invalid-signature"
  | "invalid-claims"
  | "wrong-audience"
  | "expired"
  | "overlong"
  | "future-issued"
  | "invalid-scope"

export type GrantVerification =
  | { readonly ok: true; readonly claims: DeviceRelayGrantClaims }
  | { readonly ok: false; readonly reason: GrantRejectionReason }

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const decoded = atob(padded)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes
}

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )

const validScope = (claims: DeviceRelayGrantClaims): boolean => {
  switch (claims.audience) {
    case "device-control":
      return claims.sessionId === null && claims.deviceGeneration === null
    case "device-challenge":
      return (
        claims.deviceId !== null && claims.sessionId === null && claims.deviceGeneration === null
      )
    case "device-connect":
      return (
        claims.deviceId !== null &&
        claims.sessionId === null &&
        claims.deviceGeneration !== null
      )
    case "session-tunnel":
      return (
        claims.deviceId !== null &&
        claims.sessionId !== null &&
        claims.deviceGeneration !== null
      )
  }
}

export const verifyDeviceRelayGrant = async (
  grant: string | null,
  secret: string,
  audience: DeviceRelayGrantAudience,
  nowSeconds = Math.floor(Date.now() / 1_000)
): Promise<GrantVerification> => {
  if (!grant) return { ok: false, reason: "missing" }
  const parts = grant.split(".")
  const headerPart = parts[0]
  const payloadPart = parts[1]
  const signaturePart = parts[2]
  if (!headerPart || !payloadPart || !signaturePart || parts.length !== 3 || secret.length === 0) {
    return { ok: false, reason: "malformed" }
  }
  try {
    const signed = `${headerPart}.${payloadPart}`
    const signatureValid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64Url(signaturePart),
      encoder.encode(signed)
    )
    if (!signatureValid) return { ok: false, reason: "invalid-signature" }
    const header: unknown = JSON.parse(decoder.decode(decodeBase64Url(headerPart)))
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return { ok: false, reason: "malformed" }
    }
    const headerFields = Object.fromEntries(Object.entries(header))
    if (
      headerFields.alg !== "HS256" ||
      headerFields.typ !== "JinglerDeviceGrant" ||
      headerFields.version !== 1
    ) {
      return { ok: false, reason: "malformed" }
    }
    const decoded = Schema.decodeUnknownEither(DeviceRelayGrantClaimsSchema)(
      JSON.parse(decoder.decode(decodeBase64Url(payloadPart))),
      { onExcessProperty: "error" }
    )
    if (Either.isLeft(decoded)) return { ok: false, reason: "invalid-claims" }
    const claims = decoded.right
    if (claims.audience !== audience) return { ok: false, reason: "wrong-audience" }
    if (claims.expiresAt <= nowSeconds) return { ok: false, reason: "expired" }
    if (claims.expiresAt - claims.issuedAt > REMOTE_GRANT_MAX_TTL_SECONDS) {
      return { ok: false, reason: "overlong" }
    }
    if (claims.issuedAt > nowSeconds + 60) return { ok: false, reason: "future-issued" }
    if (!validScope(claims)) return { ok: false, reason: "invalid-scope" }
    return { ok: true, claims }
  } catch {
    return { ok: false, reason: "malformed" }
  }
}

export const bearerGrant = (request: Request): string | null => {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null
  const grant = authorization.slice("Bearer ".length).trim()
  return grant.length > 0 ? grant : null
}
