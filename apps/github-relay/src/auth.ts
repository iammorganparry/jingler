export interface RelayGrantClaims {
  readonly version: 1
  readonly issuer: "jingler"
  readonly audience: "jingler-github-relay"
  readonly subject: string
  readonly installationId: string
  readonly relaySessionId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly grantId: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const decoded = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length))
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

const finiteInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )

/** Verify the short-lived server grant using Web Crypto's constant-time HMAC primitive. */
export const verifyRelayGrant = async (
  grant: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000)
): Promise<RelayGrantClaims | null> => {
  const parts = grant.split(".")
  const headerPart = parts[0]
  const payloadPart = parts[1]
  const signaturePart = parts[2]
  if (!headerPart || !payloadPart || !signaturePart || parts.length !== 3 || secret.length === 0) {
    return null
  }
  try {
    const signed = `${headerPart}.${payloadPart}`
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64Url(signaturePart),
      encoder.encode(signed)
    )
    if (!validSignature) return null

    const header = object(JSON.parse(decoder.decode(decodeBase64Url(headerPart))))
    const claims = object(JSON.parse(decoder.decode(decodeBase64Url(payloadPart))))
    if (
      header?.alg !== "HS256" ||
      header.typ !== "JinglerGitHubGrant" ||
      header.version !== 1 ||
      claims?.version !== 1 ||
      claims.issuer !== "jingler" ||
      claims.audience !== "jingler-github-relay" ||
      !nonEmptyString(claims.subject) ||
      !nonEmptyString(claims.installationId) ||
      !/^\d+$/.test(claims.installationId) ||
      !nonEmptyString(claims.relaySessionId) ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(claims.relaySessionId) ||
      !finiteInteger(claims.issuedAt) ||
      !finiteInteger(claims.expiresAt) ||
      !nonEmptyString(claims.grantId) ||
      claims.issuedAt > nowSeconds + 60 ||
      claims.expiresAt <= nowSeconds
    ) {
      return null
    }
    return {
      version: 1,
      issuer: "jingler",
      audience: "jingler-github-relay",
      subject: claims.subject,
      installationId: claims.installationId,
      relaySessionId: claims.relaySessionId,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      grantId: claims.grantId
    }
  } catch {
    return null
  }
}

export const bearerGrant = (request: Request): string | null => {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null
  const grant = authorization.slice("Bearer ".length).trim()
  return grant.length > 0 ? grant : null
}
