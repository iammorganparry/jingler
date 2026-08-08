import type {
  DeviceRelayGrantAudience,
  DeviceRelayGrantClaims
} from "@jingler/core"
import {
  DeviceChallengeExchangeRequest,
  DeviceChallengeRequest,
  DeviceKeyRotationRequest,
  DeviceRenameRequest,
  PairingClaimRequest,
  PendingDeviceRegistrationRequest,
  RemoteSessionKeyOffer
} from "@jingler/core"
import { Either, Schema } from "effect"
import { bearerGrant, verifyDeviceRelayGrant } from "./auth.js"
import { randomOpaqueId, randomPairingCode } from "./device-registry.js"
import { deviceRelayTelemetry } from "./telemetry.js"

export { bearerGrant, verifyDeviceRelayGrant } from "./auth.js"
export { DeviceRegistryObject } from "./device-registry.js"
export { SessionTunnelObject, TUNNEL_POLICY } from "./session-tunnel.js"

const MAX_JSON_BYTES = 128 * 1_024
const noStoreHeaders = { "cache-control": "no-store" } as const

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStoreHeaders })

const decodedBody = async <A, I>(
  request: Request,
  schema: Schema.Schema<A, I>
): Promise<A | null> => {
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_JSON_BYTES) {
        await reader.cancel()
        return null
      }
      const chunk = new Uint8Array(result.value.byteLength)
      chunk.set(result.value)
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const decoded = Schema.decodeUnknownEither(schema)(
      JSON.parse(new TextDecoder().decode(bytes)),
      { onExcessProperty: "error" }
    )
    return Either.isRight(decoded) ? decoded.right : null
  } catch {
    return null
  }
}

const grant = async (
  request: Request,
  env: Env,
  audience: DeviceRelayGrantAudience
): Promise<DeviceRelayGrantClaims | null> => {
  const result = await verifyDeviceRelayGrant(
    bearerGrant(request),
    env.DEVICE_RELAY_SIGNING_SECRET,
    audience
  )
  if (!result.ok) {
    deviceRelayTelemetry(
      "rejected_grant",
      {
        audience,
        method: request.method,
        path: new URL(request.url).pathname,
        reason: result.reason
      },
      "warn"
    )
  }
  return result.ok ? result.claims : null
}

const routeDeviceId = (pathname: string, suffix: string): string | null => {
  if (!pathname.startsWith("/v1/devices/") || !pathname.endsWith(suffix))
    return null
  const encoded = pathname.slice("/v1/devices/".length, -suffix.length)
  if (!encoded || encoded.includes("/")) return null
  try {
    const value = decodeURIComponent(encoded)
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
  } catch {
    return null
  }
}

const scopedDevice = (
  claims: DeviceRelayGrantClaims,
  deviceId: string
): boolean => claims.deviceId === null || claims.deviceId === deviceId

const handlePendingRegistration = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const registration = await decodedBody(
    request,
    PendingDeviceRegistrationRequest
  )
  if (!registration) return json({ error: "Invalid pending device" }, 400)
  const pendingDeviceId = randomOpaqueId("pending")
  const deviceId = randomOpaqueId("device")
  const pairingCode = randomPairingCode()
  const pending = env.DEVICE_REGISTRY.getByName(`pending:${pendingDeviceId}`)
  return json(
    await pending.registerPending({
      pendingDeviceId,
      deviceId,
      pairingCode,
      registration
    }),
    201
  )
}

const handlePairingClaim = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims) return json({ error: "Invalid device-control grant" }, 401)
  if (claims.deviceId !== null)
    return json({ error: "Grant resource mismatch" }, 403)
  const input = await decodedBody(request, PairingClaimRequest)
  if (!input) return json({ error: "Invalid pairing claim" }, 400)
  const pending = env.DEVICE_REGISTRY.getByName(
    `pending:${input.pendingDeviceId}`
  )
  const result = await pending.claimPending(
    claims.subject,
    input.pendingDeviceId,
    input.pairingCode
  )
  if (result.status !== "claimed") {
    const status =
      result.status === "expired"
        ? 410
        : result.status === "already-claimed"
          ? 409
          : result.status === "rate-limited"
            ? 429
            : result.status === "not-found"
              ? 404
              : 401
    return json({ error: `Pairing ${result.status}` }, status)
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const device = await registry.adoptClaim(claims.subject, result.device)
  return json({ version: 1, subject: claims.subject, device })
}

const handleDeviceList = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims) return json({ error: "Invalid device-control grant" }, 401)
  if (claims.deviceId !== null)
    return json({ error: "Grant resource mismatch" }, 403)
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  return json(await registry.listDevices())
}

const handleDiscovery = async (
  request: Request,
  env: Env,
  deviceId: string
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims) return json({ error: "Invalid device-control grant" }, 401)
  if (!scopedDevice(claims, deviceId)) return json({ error: "Grant resource mismatch" }, 403)
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const discovery = await registry.getDiscovery(deviceId)
  return discovery ? json(discovery) : json({ error: "Device not found" }, 404)
}

const handleRevocation = async (
  request: Request,
  env: Env,
  deviceId: string
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims) return json({ error: "Invalid device-control grant" }, 401)
  if (!scopedDevice(claims, deviceId))
    return json({ error: "Grant resource mismatch" }, 403)
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const device = await registry.revokeDevice(deviceId)
  return device
    ? json({ version: 1, device })
    : json({ error: "Device not found" }, 404)
}

const handleRename = async (
  request: Request,
  env: Env,
  deviceId: string
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims) return json({ error: "Invalid device-control grant" }, 401)
  if (!scopedDevice(claims, deviceId))
    return json({ error: "Grant resource mismatch" }, 403)
  const input = await decodedBody(request, DeviceRenameRequest)
  if (!input || input.deviceId !== deviceId)
    return json({ error: "Invalid device rename" }, 400)
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const device = await registry.renameDevice(deviceId, input.displayName)
  return device
    ? json({ version: 1, device })
    : json({ error: "Device not found" }, 404)
}

const handleRotationChallenge = async (
  request: Request,
  env: Env,
  deviceId: string
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims) return json({ error: "Invalid device-control grant" }, 401)
  if (!scopedDevice(claims, deviceId))
    return json({ error: "Grant resource mismatch" }, 403)
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const challenge = await registry.createChallenge(deviceId, "rotate-key")
  return challenge
    ? json(challenge, 201)
    : json({ error: "Device not found" }, 404)
}

const handleKeyRotation = async (
  request: Request,
  env: Env,
  deviceId: string
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims) return json({ error: "Invalid device-control grant" }, 401)
  if (!scopedDevice(claims, deviceId))
    return json({ error: "Grant resource mismatch" }, 403)
  const input = await decodedBody(request, DeviceKeyRotationRequest)
  if (
    !input ||
    input.challenge.deviceId !== deviceId ||
    input.challenge.subject !== claims.subject
  ) {
    return json({ error: "Invalid key rotation" }, 400)
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const result = await registry.rotateKey(
    input.challenge,
    input.newPublicKey,
    input.signature
  )
  return result.status === "verified"
    ? json(result)
    : json({ error: result.status }, 401)
}

const handleChallengeCreation = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const claims = await grant(request, env, "device-challenge")
  if (!claims?.deviceId)
    return json({ error: "Invalid device-challenge grant" }, 401)
  const input = await decodedBody(request, DeviceChallengeRequest)
  if (
    !input ||
    input.subject !== claims.subject ||
    input.deviceId !== claims.deviceId
  ) {
    return json({ error: "Grant resource mismatch" }, 403)
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const challenge = await registry.createChallenge(claims.deviceId, "connect")
  return challenge
    ? json(challenge, 201)
    : json({ error: "Device not found" }, 404)
}

const handleChallengeExchange = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const claims = await grant(request, env, "device-challenge")
  if (!claims?.deviceId)
    return json({ error: "Invalid device-challenge grant" }, 401)
  const input = await decodedBody(request, DeviceChallengeExchangeRequest)
  if (
    !input ||
    input.challenge.subject !== claims.subject ||
    input.challenge.deviceId !== claims.deviceId
  ) {
    return json({ error: "Grant resource mismatch" }, 403)
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const result = await registry.completeChallenge(
    input.challenge,
    input.signature
  )
  return result.status === "verified"
    ? json(result)
    : json({ error: result.status }, 401)
}

const websocketHeaders = (
  claims: DeviceRelayGrantClaims,
  endpoint?: "desktop" | "device",
  acknowledgedSequence?: string
): Headers => {
  const headers = new Headers({
    Upgrade: "websocket",
    "x-jingler-subject": claims.subject,
    "x-jingler-device-id": claims.deviceId ?? "",
    "x-jingler-device-generation": String(claims.deviceGeneration ?? 0),
    "x-jingler-expires-at": String(claims.expiresAt)
  })
  if (claims.sessionId) headers.set("x-jingler-session-id", claims.sessionId)
  if (endpoint) headers.set("x-jingler-endpoint", endpoint)
  if (acknowledgedSequence) {
    headers.set("x-jingler-acknowledged-sequence", acknowledgedSequence)
  }
  return headers
}

const handleDeviceSocket = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const claims = await grant(request, env, "device-connect")
  if (!claims?.deviceId || claims.deviceGeneration === null) {
    return json({ error: "Invalid device-connect grant" }, 401)
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const generation = await registry.assertGeneration(
    claims.deviceId,
    claims.deviceGeneration
  )
  if (!generation.active) return json({ error: "Device revoked" }, 403)
  return registry.fetch(
    new Request(request.url, { headers: websocketHeaders(claims) })
  )
}

const handleTunnelSocket = async (
  request: Request,
  env: Env,
  sessionId: string
): Promise<Response> => {
  const claims = await grant(request, env, "session-tunnel")
  if (
    !claims?.deviceId ||
    claims.deviceGeneration === null ||
    !claims.sessionId ||
    claims.sessionId !== sessionId
  ) {
    return json({ error: "Invalid session-tunnel grant" }, 401)
  }
  const url = new URL(request.url)
  const endpoint = url.searchParams.get("endpoint")
  let keyOffer: Schema.Schema.Type<typeof RemoteSessionKeyOffer> | null = null
  const encodedKeyOffer = url.searchParams.get("keyOffer")
  if (endpoint === "desktop" && encodedKeyOffer) {
    try {
      const standard = encodedKeyOffer.replaceAll("-", "+").replaceAll("_", "/")
      const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")
      keyOffer = Schema.decodeUnknownSync(RemoteSessionKeyOffer)(JSON.parse(atob(padded)))
    } catch {
      return json({ error: "Invalid session key offer" }, 400)
    }
  }
  const acknowledgedSequence =
    url.searchParams.get("acknowledgedSequence") ?? "0"
  if (
    !(endpoint === "desktop" || endpoint === "device") ||
    !/^\d+$/.test(acknowledgedSequence)
  ) {
    return json({ error: "Invalid tunnel endpoint" }, 400)
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  await registry.initializeSubject(claims.subject)
  const generation = await registry.assertGeneration(
    claims.deviceId,
    claims.deviceGeneration
  )
  if (!generation.active) return json({ error: "Device revoked" }, 403)
  if (endpoint === "desktop" && (!keyOffer || keyOffer.sessionId !== claims.sessionId || keyOffer.deviceId !== claims.deviceId || keyOffer.subject !== claims.subject)) {
    return json({ error: "Session key offer resource mismatch" }, 403)
  }
  if (
    !(await registry.registerSession(
      claims.deviceId,
      claims.deviceGeneration,
      claims.sessionId
    ))
  ) {
    return json({ error: "Session registration rejected" }, 403)
  }
  const tunnel = env.SESSION_TUNNEL.getByName(claims.sessionId)
  const initialized = await tunnel.initialize({
    sessionId: claims.sessionId,
    subject: claims.subject,
    deviceId: claims.deviceId,
    deviceGeneration: claims.deviceGeneration,
    expiresAt: claims.expiresAt
  })
  if (!initialized) return json({ error: "Tunnel resource mismatch" }, 403)
  if (endpoint === "desktop" && !(await registry.notifySession(claims.deviceId, claims.sessionId, bearerGrant(request)!, keyOffer))) {
    return json({ error: "Device offline" }, 409)
  }
  return tunnel.fetch(
    new Request(request.url, {
      headers: websocketHeaders(claims, endpoint, acknowledgedSequence)
    })
  )
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "@jingler/device-relay" })
    }
    if (request.method === "POST" && url.pathname === "/v1/pending-devices") {
      return handlePendingRegistration(request, env)
    }
    if (request.method === "POST" && url.pathname === "/v1/pairing/claim") {
      return handlePairingClaim(request, env)
    }
    if (request.method === "GET" && url.pathname === "/v1/devices") {
      return handleDeviceList(request, env)
    }
    const discoveryDeviceId = routeDeviceId(url.pathname, "/discovery")
    if (request.method === "GET" && discoveryDeviceId) {
      return handleDiscovery(request, env, discoveryDeviceId)
    }
    if (request.method === "POST" && url.pathname === "/v1/device-challenges") {
      return handleChallengeCreation(request, env)
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/device-challenges/exchange"
    ) {
      return handleChallengeExchange(request, env)
    }
    if (request.method === "GET" && url.pathname === "/v1/device-connect") {
      return handleDeviceSocket(request, env)
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/v1/session-tunnels/")
    ) {
      const sessionId = url.pathname.slice("/v1/session-tunnels/".length)
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        return json({ error: "Invalid session id" }, 400)
      }
      return handleTunnelSocket(request, env, sessionId)
    }
    const revokeDeviceId = routeDeviceId(url.pathname, "/revoke")
    if (request.method === "POST" && revokeDeviceId) {
      return handleRevocation(request, env, revokeDeviceId)
    }
    const renameDeviceId = routeDeviceId(url.pathname, "/rename")
    if (request.method === "POST" && renameDeviceId) {
      return handleRename(request, env, renameDeviceId)
    }
    const challengeDeviceId = routeDeviceId(
      url.pathname,
      "/rotation-challenges"
    )
    if (request.method === "POST" && challengeDeviceId) {
      return handleRotationChallenge(request, env, challengeDeviceId)
    }
    const rotateDeviceId = routeDeviceId(url.pathname, "/rotate-key")
    if (request.method === "POST" && rotateDeviceId) {
      return handleKeyRotation(request, env, rotateDeviceId)
    }
    return json({ error: "Not found" }, 404)
  }
} satisfies ExportedHandler<Env>

export default worker
