import type {
  DeviceChallengeExchangeRequest as DeviceChallengeExchangeRequestValue,
  DeviceChallengeRequest as DeviceChallengeRequestValue,
  DeviceKeyRotationRequest as DeviceKeyRotationRequestValue,
  DeviceRelayGrantResponse,
  PairingClaimRequest as PairingClaimRequestValue
} from "@jingler/core"
import {
  DeviceChallengeExchangeRequest,
  DeviceChallengeRequest,
  DeviceKeyRotationRequest,
  DeviceRenameRequest,
  DeviceListResponse,
  EnvironmentDiscovery,
  DeviceRelayGrantRequest,
  PairingClaimRequest
} from "@jingler/core"
import { Either, Schema } from "effect"
import { Hono } from "hono"
import { getAuth } from "./auth.js"
import { issueDeviceGrant, type IssueDeviceGrantInput } from "./device-grant.js"
import { env } from "./env.js"

const noStoreHeaders = { "cache-control": "no-store" } as const
const MAX_BODY_BYTES = 128 * 1_024

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStoreHeaders })

const VerifiedChallenge = Schema.Struct({
  status: Schema.Literal("verified"),
  subject: Schema.String.pipe(Schema.minLength(1)),
  deviceId: Schema.String.pipe(Schema.minLength(1)),
  generation: Schema.Int.pipe(Schema.positive())
})

export interface DeviceRoutesDependencies {
  readonly enabled: boolean
  readonly configured: boolean
  readonly relayUrl: string
  readonly getUserId: (headers: Headers) => Promise<string | null>
  readonly issueGrant: (
    input: IssueDeviceGrantInput
  ) => DeviceRelayGrantResponse
  readonly relayFetch: (input: string, init: RequestInit) => Promise<Response>
}

const defaultDependencies = (): DeviceRoutesDependencies => ({
  enabled: env.deviceRelayEnabled,
  configured: env.deviceRelayConfigured,
  relayUrl: env.deviceRelayUrl,
  getUserId: async (headers) => {
    const session = await getAuth()
      .api.getSession({ headers })
      .catch(() => null)
    return session?.user?.id ?? null
  },
  issueGrant: (input) =>
    issueDeviceGrant(input, {
      relayUrl: env.deviceRelayUrl,
      signingSecret: env.deviceRelaySigningSecret,
      ttlSeconds: env.deviceRelayGrantTtlSeconds
    }),
  relayFetch: (input, init) => fetch(input, init)
})

const decodeRequest = async <A, I>(
  request: Request,
  schema: Schema.Schema<A, I>
): Promise<A | null> => {
  const contentLength = request.headers.get("content-length")
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) return null
  if (!request.body) return null
  try {
    const reader = request.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_BODY_BYTES) {
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
      {
        onExcessProperty: "error"
      }
    )
    return Either.isRight(decoded) ? decoded.right : null
  } catch {
    return null
  }
}

const relayUrl = (base: string, path: string): string =>
  `${base.replace(/\/$/u, "")}${path}`

const relayRequest = (
  dependencies: DeviceRoutesDependencies,
  path: string,
  grant: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<Response> => {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${grant}`
  })
  if (body !== undefined) headers.set("content-type", "application/json")
  return dependencies.relayFetch(relayUrl(dependencies.relayUrl, path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

const forward = (response: Response): Response =>
  new Response(response.body, {
    status: response.status,
    headers: {
      ...noStoreHeaders,
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  })

const controlGrant = (
  dependencies: DeviceRoutesDependencies,
  subject: string,
  deviceId: string | null = null
): DeviceRelayGrantResponse =>
  dependencies.issueGrant({
    audience: "device-control",
    subject,
    deviceId,
    sessionId: null,
    deviceGeneration: null
  })

const authenticatedUser = async (
  request: Request,
  dependencies: DeviceRoutesDependencies
): Promise<string | null> => dependencies.getUserId(request.headers)

const configured = (dependencies: DeviceRoutesDependencies): Response | null =>
  dependencies.enabled && dependencies.configured
    ? null
    : json({ error: "Device relay unavailable" }, 503)

export const createDeviceRoutes = (
  dependenciesFactory: () => DeviceRoutesDependencies = defaultDependencies
) => {
  const routes = new Hono()

  routes.post("/grants", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const input = await decodeRequest(context.req.raw, DeviceRelayGrantRequest)
    if (!input) return json({ error: "Invalid grant request" }, 400)
    if (input.audience === "device-control") {
      if (input.deviceId !== null || input.sessionId !== null) {
        return json({ error: "Invalid device-control scope" }, 400)
      }
      return json(controlGrant(dependencies, subject))
    }
    if (!input.deviceId || !input.sessionId) {
      return json(
        { error: "Session grants require deviceId and sessionId" },
        400
      )
    }
    const control = controlGrant(dependencies, subject)
    const devicesResponse = await relayRequest(
      dependencies,
      "/v1/devices",
      control.grant,
      "GET"
    ).catch(() => null)
    if (!devicesResponse)
      return json({ error: "Device relay unavailable" }, 502)
    if (!devicesResponse.ok) return forward(devicesResponse)
    let devices: Schema.Schema.Type<typeof DeviceListResponse>
    try {
      devices = Schema.decodeUnknownSync(DeviceListResponse)(
        await devicesResponse.json()
      )
    } catch {
      return json({ error: "Invalid device relay response" }, 502)
    }
    const device = devices.devices.find(
      (candidate) =>
        candidate.deviceId === input.deviceId && candidate.state === "active"
    )
    if (!device) return json({ error: "Device not found" }, 404)
    return json(
      dependencies.issueGrant({
        audience: "session-tunnel",
        subject,
        deviceId: device.deviceId,
        sessionId: input.sessionId,
        deviceGeneration: device.generation
      })
    )
  })

  routes.post("/pairing/claim", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const input = await decodeRequest(context.req.raw, PairingClaimRequest)
    if (!input) return json({ error: "Invalid pairing claim" }, 400)
    return forward(
      await relayRequest(
        dependencies,
        "/v1/pairing/claim",
        controlGrant(dependencies, subject).grant,
        "POST",
        input satisfies PairingClaimRequestValue
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  routes.get("/", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    return forward(
      await relayRequest(
        dependencies,
        "/v1/devices",
        controlGrant(dependencies, subject).grant,
        "GET"
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  routes.get("/:deviceId/discovery", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const deviceId = context.req.param("deviceId")
    const response = await relayRequest(
      dependencies,
      `/v1/devices/${encodeURIComponent(deviceId)}/discovery`,
      controlGrant(dependencies, subject, deviceId).grant,
      "GET"
    ).catch(() => null)
    if (!response) return json({ error: "Device relay unavailable" }, 502)
    if (!response.ok) return forward(response)
    try {
      return json(Schema.decodeUnknownSync(EnvironmentDiscovery)(await response.json(), {
        onExcessProperty: "error"
      }))
    } catch {
      return json({ error: "Invalid device discovery response" }, 502)
    }
  })

  routes.post("/challenges", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const input = await decodeRequest(context.req.raw, DeviceChallengeRequest)
    if (!input) return json({ error: "Invalid challenge request" }, 400)
    const challengeGrant = dependencies.issueGrant({
      audience: "device-challenge",
      subject: input.subject,
      deviceId: input.deviceId,
      sessionId: null,
      deviceGeneration: null
    })
    return forward(
      await relayRequest(
        dependencies,
        "/v1/device-challenges",
        challengeGrant.grant,
        "POST",
        input satisfies DeviceChallengeRequestValue
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  routes.post("/challenges/exchange", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const input = await decodeRequest(
      context.req.raw,
      DeviceChallengeExchangeRequest
    )
    if (!input) return json({ error: "Invalid challenge exchange" }, 400)
    const challengeGrant = dependencies.issueGrant({
      audience: "device-challenge",
      subject: input.challenge.subject,
      deviceId: input.challenge.deviceId,
      sessionId: null,
      deviceGeneration: null
    })
    const verifiedResponse = await relayRequest(
      dependencies,
      "/v1/device-challenges/exchange",
      challengeGrant.grant,
      "POST",
      input satisfies DeviceChallengeExchangeRequestValue
    ).catch(() => null)
    if (!verifiedResponse)
      return json({ error: "Device relay unavailable" }, 502)
    if (!verifiedResponse.ok) return forward(verifiedResponse)
    let verified: Schema.Schema.Type<typeof VerifiedChallenge>
    try {
      verified = Schema.decodeUnknownSync(VerifiedChallenge)(
        await verifiedResponse.json()
      )
    } catch {
      return json({ error: "Invalid device relay response" }, 502)
    }
    if (
      verified.subject !== input.challenge.subject ||
      verified.deviceId !== input.challenge.deviceId
    ) {
      return json({ error: "Device relay response scope mismatch" }, 502)
    }
    return json(
      dependencies.issueGrant({
        audience: "device-connect",
        subject: verified.subject,
        deviceId: verified.deviceId,
        sessionId: null,
        deviceGeneration: verified.generation
      })
    )
  })

  routes.post("/:deviceId/revoke", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const deviceId = context.req.param("deviceId")
    return forward(
      await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
        controlGrant(dependencies, subject, deviceId).grant,
        "POST"
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  routes.post("/:deviceId/rename", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const deviceId = context.req.param("deviceId")
    const input = await decodeRequest(context.req.raw, DeviceRenameRequest)
    if (!input || input.deviceId !== deviceId)
      return json({ error: "Invalid device rename" }, 400)
    return forward(
      await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/rename`,
        controlGrant(dependencies, subject, deviceId).grant,
        "POST",
        input
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  routes.post("/:deviceId/rotation-challenges", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const deviceId = context.req.param("deviceId")
    return forward(
      await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/rotation-challenges`,
        controlGrant(dependencies, subject, deviceId).grant,
        "POST"
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  routes.post("/:deviceId/rotate-key", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const deviceId = context.req.param("deviceId")
    const input = await decodeRequest(context.req.raw, DeviceKeyRotationRequest)
    if (!input || input.challenge.deviceId !== deviceId) {
      return json({ error: "Invalid key rotation" }, 400)
    }
    return forward(
      await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/rotate-key`,
        controlGrant(dependencies, subject, deviceId).grant,
        "POST",
        input satisfies DeviceKeyRotationRequestValue
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  return routes
}
