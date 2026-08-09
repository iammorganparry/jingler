import type {
  DeviceRelayGrantAudience,
  DeviceRelayGrantClaims
} from "@jingler/core"
import {
  ClaimedDeviceRegistrationRequest,
  DeviceChallengeExchangeRequest,
  DeviceChallengeRequest,
  DeviceKeyRotationRequest,
  ControllerLeaseRequest,
  DeviceRenameRequest,
  PairingClaimRequest,
  PendingDeviceRegistrationRequest,
  RemoteSessionKeyOffer
} from "@jingler/core"
import { Either, Schema } from "effect"
import {
  bearerGrant,
  verifyDeviceClaim,
  verifyDeviceRelayGrant
} from "./auth.js"
import { randomOpaqueId, randomPairingCode } from "./device-registry.js"
import type { SessionTunnelObject } from "./session-tunnel.js"
import { deviceRelayTelemetry } from "./telemetry.js"
import type { RelayUsageObject } from "./usage.js"

export { bearerGrant, verifyDeviceClaim, verifyDeviceRelayGrant } from "./auth.js"
export { DeviceRegistryObject } from "./device-registry.js"
export { SessionTunnelObject, TUNNEL_POLICY } from "./session-tunnel.js"
export { RelayUsageObject, RELAY_USAGE_POLICY } from "./usage.js"

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
  if (result.ok) {
    deviceRelayTelemetry("grant_admission", {
      audience,
      clientInstanceId: result.claims.clientInstanceId,
      deviceId: result.claims.deviceId,
      method: request.method,
      path: new URL(request.url).pathname,
      sessionId: result.claims.sessionId
    })
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
  const clientKey = request.headers.get("cf-connecting-ip") ?? "unknown"
  const allowed = await env.UNAUTHENTICATED_RATE_LIMITER.limit({
    key: `pending:${clientKey}`
  })
  if (!allowed.success) return json({ error: "Too many pairing attempts" }, 429)
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

const handleClaimedRegistration = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const verified = await verifyDeviceClaim(
    bearerGrant(request),
    env.DEVICE_RELAY_SIGNING_SECRET
  )
  if (!verified.ok) {
    deviceRelayTelemetry(
      "rejected_grant",
      {
        audience: "device-claim",
        method: request.method,
        path: new URL(request.url).pathname,
        reason: verified.reason
      },
      "warn"
    )
    return json({
      _tag: "DeviceControlPlaneError",
      reason: "invalid-claim",
      message: "Device claim rejected",
      retryable: false
    }, 401)
  }
  const input = await decodedBody(request, ClaimedDeviceRegistrationRequest)
  if (!input || JSON.stringify(input.claim) !== JSON.stringify(verified.claim)) {
    return json({
      _tag: "DeviceControlPlaneError",
      reason: "invalid-claim",
      message: "Device claim resource mismatch",
      retryable: false
    }, 403)
  }
  const claimObject = env.DEVICE_REGISTRY.getByName(
    `claim:${verified.claim.claimId}`
  )
  const consumed = await claimObject.consumeDeviceClaim(verified.claim)
  if (consumed.status !== "consumed") {
    deviceRelayTelemetry(
      "device_claim",
      {
        claimId: verified.claim.claimId,
        clientInstanceId: verified.claim.clientInstanceId,
        deviceId: verified.claim.deviceId,
        outcome: consumed.status
      },
      "warn"
    )
    return json({
      _tag: "DeviceControlPlaneError",
      reason: consumed.status === "replayed" ? "replayed" : "invalid-claim",
      message:
        consumed.status === "replayed"
          ? "Device claim was already consumed"
          : "Device claim expired",
      retryable: false
    }, consumed.status === "replayed" ? 409 : 410)
  }
  const registry = env.DEVICE_REGISTRY.getByName(verified.claim.subject)
  const registered = await registry.registerClaimedDevice(
    verified.claim,
    input.registration
  )
  if (registered.status !== "registered") {
    deviceRelayTelemetry(
      "device_registration",
      {
        claimId: verified.claim.claimId,
        clientInstanceId: verified.claim.clientInstanceId,
        deviceId: verified.claim.deviceId,
        outcome: registered.status
      },
      "warn"
    )
    return json({
      _tag: "DeviceControlPlaneError",
      reason: registered.status === "revoked" ? "revoked" : "replayed",
      message:
        registered.status === "revoked"
          ? "Device was revoked"
          : "Device identity is already registered",
      retryable: false
    }, 409)
  }
  deviceRelayTelemetry("device_claim", {
    claimId: verified.claim.claimId,
    clientInstanceId: verified.claim.clientInstanceId,
    deviceId: verified.claim.deviceId,
    outcome: "consumed"
  })
  deviceRelayTelemetry("device_registration", {
    clientInstanceId: verified.claim.clientInstanceId,
    deviceId: verified.claim.deviceId,
    generation: registered.device.generation,
    outcome: "registered"
  })
  return json({ version: 1, device: registered.device }, 201)
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
  const clientKey = request.headers.get("x-jingler-client-key") ?? "unknown"
  const allowed = await env.UNAUTHENTICATED_RATE_LIMITER.limit({
    key: `challenge:${clientKey}`
  })
  if (!allowed.success) return json({ error: "Too many challenge attempts" }, 429)
  const input = await decodedBody(request, DeviceChallengeRequest)
  if (
    !input ||
    input.subject !== claims.subject ||
    input.deviceId !== claims.deviceId
  ) {
    return json({ error: "Grant resource mismatch" }, 403)
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
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
  acknowledgedSequence?: string,
  usageAttachmentId?: string,
  sourceIp?: string,
  controllerLeaseGeneration = claims.controllerLeaseGeneration ?? 0
): Headers => {
  const headers = new Headers({
    Upgrade: "websocket",
    "x-jingler-subject": claims.subject,
    "x-jingler-device-id": claims.deviceId ?? "",
    "x-jingler-device-generation": String(claims.deviceGeneration ?? 0),
    "x-jingler-client-instance-id": claims.clientInstanceId ?? "",
    "x-jingler-attachment-generation": String(
      claims.attachmentGeneration ?? 0
    ),
    "x-jingler-controller-lease-generation": String(
      controllerLeaseGeneration
    ),
    "x-jingler-expires-at": String(claims.expiresAt)
  })
  if (claims.sessionId) headers.set("x-jingler-session-id", claims.sessionId)
  if (endpoint) headers.set("x-jingler-endpoint", endpoint)
  if (acknowledgedSequence) {
    headers.set("x-jingler-acknowledged-sequence", acknowledgedSequence)
  }
  if (usageAttachmentId) headers.set("x-jingler-usage-attachment-id", usageAttachmentId)
  if (sourceIp) headers.set("x-jingler-source-ip", sourceIp)
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
    claims.sessionId !== sessionId ||
    !claims.clientInstanceId ||
    claims.attachmentGeneration === null ||
    claims.controllerLeaseGeneration === null
  ) {
    return json({ error: "Invalid session-tunnel grant" }, 401)
  }
  // A cheap edge-local guard absorbs an abusive account before it wakes the
  // strongly consistent usage/registry/tunnel objects. The usage DO remains
  // the authoritative exact limiter and quota ledger.
  const edgeAdmission = await env.AUTHENTICATED_RATE_LIMITER.limit({
    key: `session-tunnel:${claims.subject}`
  })
  if (!edgeAdmission.success) {
    return json({
      _tag: "DeviceControlPlaneError",
      reason: "rate-limited",
      message: "Relay attachment rejected: rate-limited",
      retryable: true
    }, 429)
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
  // Fail on the account/device budget before waking the session object or
  // notifying the daemon. Rejected attachments should not fan out into more
  // billed Durable Object requests.
  const usage = env.RELAY_USAGE.getByName(claims.subject)
  const usageAttachmentId = `relay_${crypto.randomUUID()}`
  const sourceIp = request.headers.get("cf-connecting-ip") ?? "unknown"
  const usageAdmission = await usage.admit({
    attachmentId: usageAttachmentId,
    deviceId: claims.deviceId,
    clientInstanceId: claims.clientInstanceId,
    sourceIp,
    expiresAt: claims.expiresAt
  })
  if (usageAdmission !== "admitted") {
    return json({
      _tag: "DeviceControlPlaneError",
      reason: usageAdmission,
      message: `Relay attachment rejected: ${usageAdmission}`,
      retryable: usageAdmission === "rate-limited"
    }, usageAdmission === "rate-limited" ? 429 : 403)
  }
  const tunnel = env.SESSION_TUNNEL.getByName(claims.sessionId)
  const admission = {
    subject: claims.subject,
    deviceId: claims.deviceId,
    sessionId: claims.sessionId,
    clientInstanceId: claims.clientInstanceId,
    attachmentGeneration: claims.attachmentGeneration,
    controllerLeaseGeneration: claims.controllerLeaseGeneration,
    expiresAt: claims.expiresAt
  }
  const preparation = await tunnel.prepareConnection({
    endpoint,
    initialization: {
      sessionId: claims.sessionId,
      subject: claims.subject,
      deviceId: claims.deviceId,
      deviceGeneration: claims.deviceGeneration,
      expiresAt: claims.expiresAt
    },
    admission
  })
  if (preparation.status !== "prepared") {
    await usage.release(usageAttachmentId)
    const reason = preparation.status
    return json({
      _tag: "DeviceControlPlaneError",
      reason:
        reason === "stale-controller" ? "stale-controller" : "offline",
      message: `Client attachment rejected: ${reason}`,
      retryable: reason === "offline" || reason === "stale-controller"
    }, reason === "offline" || reason === "stale-controller" ? 409 : 403)
  }
  if (endpoint === "desktop" && !(await registry.notifySession(
    claims.deviceId,
    claims.sessionId,
    bearerGrant(request)!,
    keyOffer,
    {
      clientInstanceId: claims.clientInstanceId,
      attachmentGeneration: claims.attachmentGeneration,
      controllerLeaseGeneration: preparation.controllerLeaseGeneration
    }
  ))) {
    await usage.release(usageAttachmentId)
    return json({
      _tag: "DeviceControlPlaneError",
      reason: "offline",
      message: "Device is offline",
      retryable: true
    }, 409)
  }
  const response = await tunnel.fetch(
    new Request(request.url, {
      headers: websocketHeaders(
        claims,
        endpoint,
        acknowledgedSequence,
        usageAttachmentId,
        sourceIp,
        preparation.controllerLeaseGeneration
      )
    })
  )
  if (response.status !== 101) await usage.release(usageAttachmentId)
  return response
}

const scopedSessionClaims = async (
  request: Request,
  env: Env,
  sessionId: string
): Promise<{
  readonly claims: DeviceRelayGrantClaims
  readonly tunnel: DurableObjectStub<SessionTunnelObject>
  readonly admission: {
    readonly subject: string
    readonly deviceId: string
    readonly sessionId: string
    readonly clientInstanceId: string
    readonly attachmentGeneration: number
    readonly controllerLeaseGeneration: number
    readonly expiresAt: number
  }
} | null> => {
  const claims = await grant(request, env, "session-tunnel")
  if (
    !claims?.deviceId ||
    claims.deviceGeneration === null ||
    claims.sessionId !== sessionId ||
    !claims.clientInstanceId ||
    claims.attachmentGeneration === null ||
    claims.controllerLeaseGeneration === null
  ) {
    return null
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  if (
    !(await registry.registerSession(
      claims.deviceId,
      claims.deviceGeneration,
      sessionId
    ))
  ) {
    return null
  }
  const tunnel = env.SESSION_TUNNEL.getByName(sessionId)
  if (
    !(await tunnel.initialize({
      sessionId,
      subject: claims.subject,
      deviceId: claims.deviceId,
      deviceGeneration: claims.deviceGeneration,
      expiresAt: claims.expiresAt
    }))
  ) {
    return null
  }
  return {
    claims,
    tunnel,
    admission: {
      subject: claims.subject,
      deviceId: claims.deviceId,
      sessionId,
      clientInstanceId: claims.clientInstanceId,
      attachmentGeneration: claims.attachmentGeneration,
      controllerLeaseGeneration: claims.controllerLeaseGeneration,
      expiresAt: claims.expiresAt
    }
  }
}

const controlPlaneFailure = (status: string): Response => {
  const reason =
    status === "stale-controller"
      ? "stale-controller"
      : status === "revoked"
        ? "revoked"
      : status === "offline"
        ? "offline"
        : status === "replayed"
          ? "replayed"
          : "invalid-grant"
  return json(
    {
      _tag: "DeviceControlPlaneError",
      reason,
      message: `Relay operation rejected: ${status}`,
      retryable: reason === "offline" || reason === "stale-controller"
    },
    reason === "offline" ? 409 : 403
  )
}

const handleClientAttachment = async (
  request: Request,
  env: Env,
  sessionId: string
): Promise<Response> => {
  const scope = await scopedSessionClaims(request, env, sessionId)
  if (!scope) return controlPlaneFailure("invalid-grant")
  const result = await scope.tunnel.attachClient(scope.admission)
  deviceRelayTelemetry(
    "client_attachment",
    {
      attachmentGeneration: scope.admission.attachmentGeneration,
      clientInstanceId: scope.admission.clientInstanceId,
      deviceId: scope.admission.deviceId,
      outcome: result.status,
      sessionId
    },
    result.status === "attached" ? "info" : "warn"
  )
  return result.status === "attached" ? json(result.attachment, 201) : controlPlaneFailure(result.status)
}

const handleControllerLease = async (
  request: Request,
  env: Env,
  sessionId: string,
  operation: "acquire" | "takeover" | "release"
): Promise<Response> => {
  const scope = await scopedSessionClaims(request, env, sessionId)
  if (!scope) return controlPlaneFailure("invalid-grant")
  const input = await decodedBody(request, ControllerLeaseRequest)
  if (
    !input ||
    input.clientInstanceId !== scope.admission.clientInstanceId ||
    input.expectedGeneration !== scope.admission.controllerLeaseGeneration ||
    input.takeover !== (operation === "takeover")
  ) {
    return controlPlaneFailure("scope-mismatch")
  }
  const result =
    operation === "release"
      ? await scope.tunnel.releaseController({
          ...scope.admission,
          expectedGeneration: input.expectedGeneration
        })
      : await scope.tunnel.acquireController({
          ...scope.admission,
          expectedGeneration: input.expectedGeneration,
          takeover: operation === "takeover"
        })
  deviceRelayTelemetry(
    "controller_lease",
    {
      clientInstanceId: input.clientInstanceId,
      deviceId: scope.admission.deviceId,
      generation:
        result.status === "acquired" || result.status === "released"
          ? result.lease.generation
          : input.expectedGeneration,
      operation,
      outcome: result.status,
      sessionId
    },
    result.status === "acquired" || result.status === "released"
      ? "info"
      : "warn"
  )
  return result.status === "acquired" || result.status === "released"
    ? json(result.lease)
    : controlPlaneFailure(result.status)
}

const handleSessionInventory = async (
  request: Request,
  env: Env,
  deviceId: string,
  requestedSessionId?: string
): Promise<Response> => {
  const claims = await grant(request, env, "device-control")
  if (!claims || !scopedDevice(claims, deviceId)) {
    return controlPlaneFailure("invalid-grant")
  }
  const registry = env.DEVICE_REGISTRY.getByName(claims.subject)
  if (requestedSessionId) {
    const entry = await env.SESSION_TUNNEL
      .getByName(requestedSessionId)
      .inventoryEntryFor(claims.subject, deviceId)
    return json({
      version: 1,
      deviceId,
      generatedAt: Math.floor(Date.now() / 1_000),
      sessions: entry ? [entry] : []
    })
  }
  const sessionIds = await registry.listSessionIds(deviceId)
  if (!sessionIds) return controlPlaneFailure("offline")
  const entries = await Promise.all(
    sessionIds.map((sessionId) =>
      env.SESSION_TUNNEL.getByName(sessionId).inventoryEntry()
    )
  )
  return json({
    version: 1,
    deviceId,
    generatedAt: Math.floor(Date.now() / 1_000),
    sessions: entries.filter((entry) => entry !== null)
  })
}

const sessionOperationId = (
  pathname: string,
  suffix: string
): string | null => {
  if (!pathname.startsWith("/v1/session-tunnels/") || !pathname.endsWith(suffix)) {
    return null
  }
  const sessionId = pathname.slice(
    "/v1/session-tunnels/".length,
    -suffix.length
  )
  return /^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) ? sessionId : null
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
    if (
      request.method === "POST" &&
      url.pathname === "/v1/device-registrations"
    ) {
      return handleClaimedRegistration(request, env)
    }
    if (request.method === "POST" && url.pathname === "/v1/pairing/claim") {
      return handlePairingClaim(request, env)
    }
    if (request.method === "GET" && url.pathname === "/v1/devices") {
      return handleDeviceList(request, env)
    }
    const inventoryDeviceId = routeDeviceId(url.pathname, "/sessions")
    if (request.method === "GET" && inventoryDeviceId) {
      return handleSessionInventory(request, env, inventoryDeviceId)
    }
    const targetedInventory = url.pathname.match(
      /^\/v1\/devices\/([A-Za-z0-9_-]{1,128})\/sessions\/([A-Za-z0-9_-]{1,128})$/u
    )
    if (request.method === "GET" && targetedInventory) {
      return handleSessionInventory(
        request,
        env,
        targetedInventory[1]!,
        targetedInventory[2]!
      )
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
    const attachmentSessionId = sessionOperationId(
      url.pathname,
      "/attachments"
    )
    if (request.method === "POST" && attachmentSessionId) {
      return handleClientAttachment(request, env, attachmentSessionId)
    }
    const acquireSessionId = sessionOperationId(
      url.pathname,
      "/controller/acquire"
    )
    if (request.method === "POST" && acquireSessionId) {
      return handleControllerLease(request, env, acquireSessionId, "acquire")
    }
    const takeoverSessionId = sessionOperationId(
      url.pathname,
      "/controller/takeover"
    )
    if (request.method === "POST" && takeoverSessionId) {
      return handleControllerLease(request, env, takeoverSessionId, "takeover")
    }
    const releaseSessionId = sessionOperationId(
      url.pathname,
      "/controller/release"
    )
    if (request.method === "POST" && releaseSessionId) {
      return handleControllerLease(request, env, releaseSessionId, "release")
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
