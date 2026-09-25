import { EndpointControlInput } from "@jingler/core"
import type {
  AccountDevice,
  DeviceRecord,
  DeviceChallengeExchangeRequest as DeviceChallengeExchangeRequestValue,
  DeviceChallengeRequest as DeviceChallengeRequestValue,
  DeviceKeyRotationRequest as DeviceKeyRotationRequestValue,
  DeviceRelayGrantResponse,
  PairingClaimRequest as PairingClaimRequestValue
} from "@jingler/core"
import {
  AccountDeviceListResponse,
  DeviceBootstrapConfiguration,
  DeviceRegistrationRequest,
  DeviceClaimRequest,
  DeviceChallengeExchangeRequest,
  DeviceChallengeRequest,
  DeviceKeyRotationRequest,
  DeviceRenameRequest,
  DeviceListResponse,
  EnvironmentDiscovery,
  DeviceRelayGrantRequest,
  RemoteSessionInventory,
  PairingClaimRequest
} from "@jingler/core"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { Hono, type Context } from "hono"
import { getAuth } from "./auth.js"
import {
  issueDeviceClaim,
  issueDeviceGrant,
  verifyDeviceClaim,
  type IssueDeviceClaimInput,
  type IssueDeviceGrantInput,
  type IssuedDeviceClaim
} from "./device-grant.js"
import { DeviceRepository, type DeviceEnrollmentResult } from "./db/repositories/device-repository.js"
import { env } from "./env.js"
import { decodeBoundedJson } from "./request-decoding.js"
import { runtime } from "./runtime.js"

const noStoreHeaders = { "cache-control": "no-store" } as const
type DeviceServerTelemetryValue = string | number | boolean | null

const deviceServerTelemetry = (
  event: "bootstrap_discovery" | "device_claim" | "grant_issued",
  fields: Readonly<Record<string, DeviceServerTelemetryValue>>,
  level: "info" | "warn" = "info"
): void => {
  console.log(
    JSON.stringify({
      ...fields,
      component: "device-control-server",
      level,
      event,
      timestamp: new Date().toISOString()
    })
  )
}

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
  readonly bootstrapTtlSeconds: number
  readonly nowSeconds: () => number
  readonly getUserId: (headers: Headers) => Promise<string | null>
  readonly issueGrant: (
    input: IssueDeviceGrantInput
  ) => DeviceRelayGrantResponse
  readonly issueClaim: (input: IssueDeviceClaimInput) => IssuedDeviceClaim
  readonly verifyClaim?: (token: string, nowSeconds: number) => IssuedDeviceClaim["claim"]
  readonly relayFetch: (input: string, init: RequestInit) => Promise<Response>
  readonly deviceStore?: DeviceStore
}

export interface DeviceStore {
  readonly createEnrollment: (credential: IssuedDeviceClaim["claim"]) => Promise<void>
  readonly consumeAndUpsert: (input: {
    readonly credential: IssuedDeviceClaim["claim"]
    readonly identityFingerprint: string
    readonly registration: Schema.Schema.Type<typeof DeviceRegistrationRequest>["registration"]
    readonly at: Date
  }) => Promise<DeviceEnrollmentResult>
  readonly listForUser: (userId: string) => Promise<ReadonlyArray<DeviceRecord>>
  readonly findForUser: (userId: string, deviceId: string) => Promise<DeviceRecord | null>
  readonly renameForUser: (input: {
    readonly userId: string
    readonly deviceId: string
    readonly displayName: string
    readonly at: Date
  }) => Promise<DeviceRecord | null>
  readonly revokeForUser: (input: {
    readonly userId: string
    readonly deviceId: string
    readonly at: Date
  }) => Promise<DeviceRecord | null>
}

const persistentDeviceStore: DeviceStore = {
  createEnrollment: (credential) =>
    runtime.runPromise(DeviceRepository.createEnrollment(credential)),
  consumeAndUpsert: (input) =>
    runtime.runPromise(DeviceRepository.consumeAndUpsert(input)),
  listForUser: (userId) => runtime.runPromise(DeviceRepository.listForUser(userId)),
  findForUser: (userId, deviceId) =>
    runtime.runPromise(DeviceRepository.findForUser(userId, deviceId)),
  renameForUser: (input) => runtime.runPromise(DeviceRepository.renameForUser(input)),
  revokeForUser: (input) => runtime.runPromise(DeviceRepository.revokeForUser(input))
}

const deviceStore = (dependencies: DeviceRoutesDependencies): DeviceStore =>
  dependencies.deviceStore ?? persistentDeviceStore

const defaultDependencies = (): DeviceRoutesDependencies => ({
  enabled: env.deviceRelayEnabled,
  configured: env.deviceRelayConfigured,
  relayUrl: env.deviceRelayUrl,
  bootstrapTtlSeconds: env.deviceBootstrapTtlSeconds,
  nowSeconds: () => Math.floor(Date.now() / 1_000),
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
  issueClaim: (input) =>
    issueDeviceClaim(input, {
      signingSecret: env.deviceRelaySigningSecret,
      ttlSeconds: env.deviceRelayGrantTtlSeconds
    }),
  relayFetch: (input, init) => fetch(input, init)
})

const discoveryResponse = (value: unknown, deviceId: string, targetId?: string): Response => {
  const discovery = Schema.decodeUnknownSync(EnvironmentDiscovery)(value, { onExcessProperty: "error" })
  const capabilities = discovery.discovery?.capabilities
  if (discovery.deviceId !== deviceId || (targetId && (
    capabilities?.runtime?.targetId !== targetId ||
    capabilities?.endpointCatalog?.endpoints.some(({ endpoint }) => endpoint.targetId !== targetId)
  ))) return json({ error: "Device discovery target mismatch" }, 502)
  return json(discovery)
}

const requestDiscovery = async (
  request: Request,
  dependencies: DeviceRoutesDependencies,
  subject: string,
  clientInstanceId: string,
  deviceId: string
): Promise<Response> => {
  const input = request.method === "POST"
    ? await decodeBoundedJson(request, EndpointControlInput)
    : undefined
  if (input === null) return json({ error: "Invalid endpoint catalog request" }, 400)
  const response = await relayRequest(
    dependencies,
    `/v1/devices/${encodeURIComponent(deviceId)}/discovery`,
    controlGrant(dependencies, subject, clientInstanceId, deviceId).grant,
    input ? "POST" : "GET",
    input
  ).catch(() => null)
  if (!response) return json({ error: "Device relay unavailable" }, 502)
  if (!response.ok) return forward(response)
  try {
    return discoveryResponse(await response.json(), deviceId, input?.targetId)
  } catch {
    return json({ error: "Invalid device discovery response" }, 502)
  }
}

const relayUrl = (base: string, path: string): string =>
  `${base.replace(/\/$/u, "")}${path}`

const relayRequest = (
  dependencies: DeviceRoutesDependencies,
  path: string,
  grant: string,
  method: "GET" | "POST",
  body?: unknown,
  extraHeaders?: Readonly<Record<string, string>>
): Promise<Response> => {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${grant}`
  })
  if (body !== undefined) headers.set("content-type", "application/json")
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value)
  }
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
  clientInstanceId: string,
  deviceId: string | null = null
): DeviceRelayGrantResponse =>
  dependencies.issueGrant({
    audience: "device-control",
    subject,
    deviceId,
    sessionId: null,
    clientInstanceId,
    attachmentGeneration: null,
    controllerLeaseGeneration: null,
    deviceGeneration: null
  })

const requestClientInstanceId = (request: Request, subject: string): string => {
  const value = request.headers.get("x-jingler-client-instance-id")
  if (value && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) return value
  // Compatibility for clients released before per-install client identities.
  // The bearer is already the authentication boundary; hashing it produces a
  // stable, non-secret fencing identity without collapsing every account client
  // onto the same controller lease.
  const bearer = request.headers.get("authorization") ?? ""
  const digest = createHash("sha256")
    .update(`${subject}\0${bearer}`, "utf8")
    .digest("base64url")
    .slice(0, 32)
  return `legacy_${digest}`
}

const authenticatedUser = async (
  request: Request,
  dependencies: DeviceRoutesDependencies
): Promise<string | null> => dependencies.getUserId(request.headers)

const configured = (dependencies: DeviceRoutesDependencies): Response | null =>
  dependencies.enabled && dependencies.configured
    ? null
    : json(
        {
          _tag: "DeviceControlPlaneError",
          reason: dependencies.enabled ? "invalid-configuration" : "disabled",
          message: dependencies.enabled
            ? "Device relay configuration is incomplete"
            : "Remote devices are disabled",
          retryable: false
        },
        503
      )

export const loadAccountDevices = async (
  dependencies: DeviceRoutesDependencies,
  subject: string,
  clientInstanceId: string
): Promise<ReadonlyArray<AccountDevice>> => {
  const records = await deviceStore(dependencies).listForUser(subject)
  const relayDevices = await relayRequest(
    dependencies,
    "/v1/devices",
    controlGrant(dependencies, subject, clientInstanceId).grant,
    "GET"
  )
    .then(async (response) => {
      if (!response.ok) return []
      return Schema.decodeUnknownSync(DeviceListResponse)(await response.json()).devices
    })
    .catch(() => [])
  const presence = new Map(relayDevices.map((entry) => [entry.deviceId, entry.presence]))
  return records.map((record) => {
    const current = presence.get(record.deviceId)
    return {
      ...record,
      presence: {
        version: 1 as const,
        deviceId: record.deviceId,
        state: current?.state ?? "offline",
        connectedAt: current?.connectedAt ?? null,
        lastSeenAt: current?.lastSeenAt ?? null,
        activeSessionIds: current?.activeSessionIds ?? []
      }
    }
  })
}

export const loadAccountDevicesForUser = (
  subject: string
): Promise<ReadonlyArray<AccountDevice>> =>
  loadAccountDevices(
    defaultDependencies(),
    subject,
    `client_server_${createHash("sha256").update(subject).digest("base64url").slice(0, 24)}`
  )

export const createDeviceRoutes = (
  dependenciesFactory: () => DeviceRoutesDependencies = defaultDependencies
) => {
  const routes = new Hono()

  const issueEnrollmentCredential = async (context: Context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const input = await decodeBoundedJson(context.req.raw, DeviceClaimRequest)
    if (!input) return json({ error: "Invalid device enrollment request" }, 400)
    const issued = dependencies.issueClaim({
      subject,
      deviceId: input.deviceId,
      clientInstanceId: input.clientInstanceId
    })
    try {
      await deviceStore(dependencies).createEnrollment(issued.claim)
    } catch {
      return json({ error: "Device enrollment unavailable" }, 503)
    }
    deviceServerTelemetry("device_claim", {
      claimId: issued.claim.claimId,
      clientInstanceId: issued.claim.clientInstanceId,
      deviceId: issued.claim.deviceId,
      outcome: "issued"
    })
    return json({
      version: 1,
      claim: issued.claim,
      token: issued.token
    }, 201)
  }

  routes.get("/bootstrap", (context) => {
    const dependencies = dependenciesFactory()
    let relayOrigin: string
    try {
      relayOrigin = new URL(dependencies.relayUrl).origin
    } catch {
      deviceServerTelemetry(
        "bootstrap_discovery",
        { enabled: dependencies.enabled, outcome: "invalid-configuration" },
        "warn"
      )
      return json(
        {
          _tag: "DeviceControlPlaneError",
          reason: "invalid-configuration",
          message: "Device relay origin is invalid",
          retryable: false
        },
        503
      )
    }
    if (dependencies.enabled && !dependencies.configured) {
      deviceServerTelemetry(
        "bootstrap_discovery",
        { enabled: true, outcome: "invalid-configuration" },
        "warn"
      )
      return configured(dependencies)!
    }
    const issuedAt = dependencies.nowSeconds()
    const configuration = Schema.decodeUnknownSync(
      DeviceBootstrapConfiguration
    )({
      version: 1,
      enabled: dependencies.enabled && dependencies.configured,
      relayOrigin,
      protocols: ["jingler-device-v1", "jingler-session-v1"],
      issuedAt,
      expiresAt: issuedAt + dependencies.bootstrapTtlSeconds,
      cacheMaxAgeSeconds: dependencies.bootstrapTtlSeconds
    })
    deviceServerTelemetry("bootstrap_discovery", {
      enabled: configuration.enabled,
      outcome: "served",
      protocolCount: configuration.protocols.length
    })
    return Response.json(configuration, {
      headers: {
        "cache-control": `public, max-age=${configuration.cacheMaxAgeSeconds}`,
        expires: new Date(configuration.expiresAt * 1_000).toUTCString()
      }
    })
  })

  routes.post("/enrollment-credentials", issueEnrollmentCredential)
  // Temporary wire compatibility for already-built desktop clients.
  routes.post("/claims", issueEnrollmentCredential)

  routes.post("/enrollments/exchange", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const token = context.req.header("authorization")?.replace(/^Bearer\s+/iu, "")
    if (!token) return json({ error: "Enrollment credential required" }, 401)
    let credential: IssuedDeviceClaim["claim"]
    try {
      credential = dependencies.verifyClaim
        ? dependencies.verifyClaim(token, dependencies.nowSeconds())
        : verifyDeviceClaim(
            token,
            env.deviceRelaySigningSecret,
            dependencies.nowSeconds()
          )
    } catch {
      return json({
        _tag: "DeviceControlPlaneError",
        reason: "invalid-claim",
        message: "Device enrollment credential is invalid",
        retryable: false
      }, 401)
    }
    const input = await decodeBoundedJson(context.req.raw, DeviceRegistrationRequest)
    if (!input || input.credentialId !== credential.claimId) {
      return json({
        _tag: "DeviceControlPlaneError",
        reason: "claim-mismatch",
        message: "Device enrollment credential scope does not match",
        retryable: false
      }, 401)
    }
    const registerEnrollment = async (): Promise<Response> => {
      const identityFingerprint = createHash("sha256")
        .update(input.registration.publicKey.value, "utf8")
        .digest("base64url")
      let result: DeviceEnrollmentResult
      try {
        result = await deviceStore(dependencies).consumeAndUpsert({
          credential,
          identityFingerprint,
          registration: input.registration,
          at: new Date(dependencies.nowSeconds() * 1_000)
        })
      } catch {
        return json({ error: "Device enrollment unavailable" }, 503)
      }
      if (result.status !== "registered") {
        return json({
          _tag: "DeviceControlPlaneError",
          reason: result.status,
          message: `Device enrollment rejected: ${result.status}`,
          retryable: false
        }, result.status === "expired" ? 401 : 409)
      }
      const synchronizeEnrolledDevice = async (): Promise<Response> => {
        const relayCredential = result.device.deviceId === credential.deviceId
          ? { claim: credential, token }
          : dependencies.issueClaim({
            subject: credential.subject,
            deviceId: result.device.deviceId,
            clientInstanceId: credential.clientInstanceId
          })
        const relayRegistration = await relayRequest(
          dependencies,
          "/v1/device-registrations",
          relayCredential.token,
          "POST",
          { version: 1, claim: relayCredential.claim, registration: input.registration }
        ).catch(() => null)
        // A lost relay response can make an exact enrollment retry observe the
        // relay's one-use claim as replayed. The database identity fence above
        // proves this is the same registration, so only that typed 409 is safe.
        const relayReplay = relayRegistration?.status === 409
          ? await relayRegistration.clone().json().then(
            (body: unknown) =>
              typeof body === "object" &&
              body !== null &&
              "reason" in body &&
              body.reason === "replayed",
            () => false
          )
          : false
        if (!relayRegistration?.ok && !relayReplay) {
          return json({
            _tag: "DeviceControlPlaneError",
            reason: "offline",
            message: "Device was enrolled but relay synchronization failed",
            retryable: true
          }, 503)
        }
        return json({ version: 1, device: result.device }, 201)
      }
      return synchronizeEnrolledDevice()
    }
    return registerEnrollment()
  })

  routes.post("/grants", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const input = await decodeBoundedJson(context.req.raw, DeviceRelayGrantRequest)
    if (!input) return json({ error: "Invalid grant request" }, 400)
    if (input.audience === "device-control") {
      if (input.deviceId !== null || input.sessionId !== null) {
        return json({ error: "Invalid device-control scope" }, 400)
      }
      const clientInstanceId = input.clientInstanceId ??
        requestClientInstanceId(context.req.raw, subject)
      const issued = controlGrant(
        dependencies,
        subject,
        clientInstanceId
      )
      deviceServerTelemetry("grant_issued", {
        audience: issued.claims.audience,
        clientInstanceId: issued.claims.clientInstanceId,
        deviceId: issued.claims.deviceId,
        sessionId: issued.claims.sessionId
      })
      return json(issued)
    }

    return issueSessionTunnelGrant(input, dependencies, subject, context)
  })

  routes.post("/pairing/claim", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const clientInstanceId = requestClientInstanceId(context.req.raw, subject)
    const input = await decodeBoundedJson(context.req.raw, PairingClaimRequest)
    if (!input) return json({ error: "Invalid pairing claim" }, 400)
    return forward(
      await relayRequest(
        dependencies,
        "/v1/pairing/claim",
        controlGrant(dependencies, subject, clientInstanceId).grant,
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
    const clientInstanceId = requestClientInstanceId(context.req.raw, subject)
    try {
      const devices = await loadAccountDevices(
        dependencies,
        subject,
        clientInstanceId
      )
      return json(
        Schema.decodeUnknownSync(AccountDeviceListResponse)({
          version: 1,
          devices
        })
      )
    } catch {
      return json({ error: "Device registry unavailable" }, 503)
    }
  })

  routes.get("/:deviceId", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const device = await deviceStore(dependencies)
      .findForUser(subject, context.req.param("deviceId"))
      .catch(() => null)
    return device ? json({ version: 1, device }) : json({ error: "Device not found" }, 404)
  })

  routes.on(["GET", "POST"], "/:deviceId/discovery", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const clientInstanceId = requestClientInstanceId(context.req.raw, subject)
    const deviceId = context.req.param("deviceId")
    const owned = await deviceStore(dependencies)
      .findForUser(subject, deviceId)
      .catch(() => null)
    if (!owned || owned.state !== "active") return json({ error: "Device not found" }, 404)
    return requestDiscovery(context.req.raw, dependencies, subject, clientInstanceId, deviceId)
  })

  routes.post("/challenges", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const input = await decodeBoundedJson(context.req.raw, DeviceChallengeRequest)
    if (!input) return json({ error: "Invalid challenge request" }, 400)
    const challengeGrant = dependencies.issueGrant({
      audience: "device-challenge",
      subject: input.subject,
      deviceId: input.deviceId,
      sessionId: null,
      clientInstanceId: null,
      attachmentGeneration: null,
      controllerLeaseGeneration: null,
      deviceGeneration: null
    })
    const clientKey =
      context.req.header("cf-connecting-ip") ??
      context.req.header("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
      "unknown"
    return forward(
      await relayRequest(
        dependencies,
        "/v1/device-challenges",
        challengeGrant.grant,
        "POST",
        input satisfies DeviceChallengeRequestValue,
        { "x-jingler-client-key": clientKey.slice(0, 128) }
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  routes.post("/challenges/exchange", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const input = await decodeBoundedJson(
      context.req.raw,
      DeviceChallengeExchangeRequest
    )
    if (!input) return json({ error: "Invalid challenge exchange" }, 400)
    const challengeGrant = dependencies.issueGrant({
      audience: "device-challenge",
      subject: input.challenge.subject,
      deviceId: input.challenge.deviceId,
      sessionId: null,
      clientInstanceId: null,
      attachmentGeneration: null,
      controllerLeaseGeneration: null,
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
        clientInstanceId: null,
        attachmentGeneration: null,
        controllerLeaseGeneration: null,
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
    const clientInstanceId = requestClientInstanceId(context.req.raw, subject)
    const deviceId = context.req.param("deviceId")
    const revoked = await deviceStore(dependencies).revokeForUser({
      userId: subject,
      deviceId,
      at: new Date(dependencies.nowSeconds() * 1_000)
    }).catch(() => null)
    if (!revoked) return json({ error: "Device not found" }, 404)
    const relayResponse = await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
        controlGrant(dependencies, subject, clientInstanceId, deviceId).grant,
        "POST"
      ).catch(() => null)
    return json({ version: 1, device: revoked, relayInvalidated: relayResponse?.ok ?? false })
  })

  routes.post("/:deviceId/rename", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const clientInstanceId = requestClientInstanceId(context.req.raw, subject)
    const deviceId = context.req.param("deviceId")
    const input = await decodeBoundedJson(context.req.raw, DeviceRenameRequest)
    if (!input || input.deviceId !== deviceId)
      return json({ error: "Invalid device rename" }, 400)
    const renamed = await deviceStore(dependencies).renameForUser({
      userId: subject,
      deviceId,
      displayName: input.displayName,
      at: new Date(dependencies.nowSeconds() * 1_000)
    }).catch(() => null)
    if (!renamed) return json({ error: "Device not found" }, 404)
    const relayResponse = await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/rename`,
        controlGrant(dependencies, subject, clientInstanceId, deviceId).grant,
        "POST",
        input
      ).catch(() => null)
    return json({ version: 1, device: renamed, relayInvalidated: relayResponse?.ok ?? false })
  })

  routes.post("/:deviceId/rotation-challenges", async (context) => {
    const dependencies = dependenciesFactory()
    const unavailable = configured(dependencies)
    if (unavailable) return unavailable
    const subject = await authenticatedUser(context.req.raw, dependencies)
    if (!subject) return json({ error: "Authentication required" }, 401)
    const clientInstanceId = requestClientInstanceId(context.req.raw, subject)
    const deviceId = context.req.param("deviceId")
    return forward(
      await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/rotation-challenges`,
        controlGrant(dependencies, subject, clientInstanceId, deviceId).grant,
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
    const clientInstanceId = requestClientInstanceId(context.req.raw, subject)
    const deviceId = context.req.param("deviceId")
    const input = await decodeBoundedJson(context.req.raw, DeviceKeyRotationRequest)
    if (!input || input.challenge.deviceId !== deviceId) {
      return json({ error: "Invalid key rotation" }, 400)
    }
    return forward(
      await relayRequest(
        dependencies,
        `/v1/devices/${encodeURIComponent(deviceId)}/rotate-key`,
        controlGrant(dependencies, subject, clientInstanceId, deviceId).grant,
        "POST",
        input satisfies DeviceKeyRotationRequestValue
      ).catch(() => json({ error: "Device relay unavailable" }, 502))
    )
  })

  return routes
}

const issueSessionTunnelGrant = async (
  input: Schema.Schema.Type<typeof DeviceRelayGrantRequest>,
  dependencies: DeviceRoutesDependencies,
  subject: string,
  context: Context
): Promise<Response> => {
  if (!input.deviceId || !input.sessionId) {
    return json(
      { error: "Session grants require deviceId and sessionId" },
      400
    )
  }
  const device = await deviceStore(dependencies)
    .findForUser(subject, input.deviceId)
    .catch(() => null)
  if (!device) return json({ error: "Device not found" }, 404)
  if (device.state !== "active") return json({ error: "Device revoked" }, 409)
  const clientInstanceId = input.clientInstanceId ??
    requestClientInstanceId(context.req.raw, subject)
  const inventoryResponse = await relayRequest(
    dependencies,
    `/v1/devices/${encodeURIComponent(device.deviceId)}/sessions/${encodeURIComponent(input.sessionId)}`,
    controlGrant(dependencies, subject, clientInstanceId, device.deviceId).grant,
    "GET"
  ).catch(() => null)
  if (!inventoryResponse?.ok) {
    return inventoryResponse
      ? forward(inventoryResponse)
      : json({ error: "Device relay unavailable" }, 502)
  }
  const grantFromSessionInventory = async (): Promise<Response> => {
    let controllerLeaseGeneration = 1
    try {
      const inventory = Schema.decodeUnknownSync(RemoteSessionInventory)(
        await inventoryResponse.json(),
        { onExcessProperty: "error" }
      )
      controllerLeaseGeneration = inventory.sessions.find(
        (session) => session.sessionId === input.sessionId
      )?.controllerLeaseGeneration ?? 1
    } catch {
      return json({ error: "Invalid device session inventory response" }, 502)
    }
    const issued = dependencies.issueGrant({
      audience: "session-tunnel",
      subject,
      deviceId: device.deviceId,
      sessionId: input.sessionId,
      clientInstanceId,
      attachmentGeneration: 1,
      controllerLeaseGeneration,
      deviceGeneration: device.generation
    })
    deviceServerTelemetry("grant_issued", {
      audience: issued.claims.audience,
      clientInstanceId: issued.claims.clientInstanceId,
      deviceId: issued.claims.deviceId,
      sessionId: issued.claims.sessionId
    })
    return json(issued)
  }
  return grantFromSessionInventory()
}
