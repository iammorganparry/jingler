import type { AgentEndpointCatalog } from "@jingler/core"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { WebSocket, WebSocketServer } from "ws"

const TOKEN = "e2e-token"
const SUBJECT = "u_e2e"
const DEVICE_ID = "device_buildbox_abcdefgh"
const PENDING_ID = "pending_buildbox_abcdefgh"
const PAIRING_CODE = "CL1VE2E3".replace("1", "J")

type Registration = {
  readonly displayName: string
  readonly platform: { readonly os: string; readonly arch: string }
  readonly publicKey: unknown
  readonly encryptionPublicKey?: unknown
  readonly capabilities: unknown
}

type Tunnel = {
  desktop?: WebSocket
  device?: WebSocket
  readonly envelopes: Array<Record<string, unknown>>
  keyOffer?: unknown
  clientInstanceId?: string
  attachmentGeneration?: number
  controllerLeaseGeneration?: number
}

export interface FakeDeviceRelayOptions {
  readonly deviceAgentBundle: string
  readonly deviceHome: string
  readonly deviceBinDir: string
  readonly piFixture?: {
    readonly file: string
    readonly connectionId: string
    readonly providerId: string
    readonly modelId: string
  }
  readonly agentEnv?: Readonly<Record<string, string>>
  /** Real-host QA activates the uploaded daemon over SSH instead of spawning one locally. */
  readonly spawnAgentOnClaim?: boolean
  readonly listenHost?: string
  readonly publicHost?: string
}

export interface FakeDeviceRelay {
  readonly url: string
  readonly token: string
  readonly deviceHome: string
  readonly setEndpointCatalog: (catalog: AgentEndpointCatalog) => void
  readonly ready: () => boolean
  readonly endpointRequests: () => readonly string[]
  readonly sshClaims: () => number
  readonly desktopBearerForwarded: () => boolean
  readonly commandAdmissions: (sessionId: string, operation?: string) => number
  readonly interruptSession: (sessionId: string) => void
  readonly setDeviceState: (state: "online" | "offline" | "incompatible") => void
  readonly close: () => Promise<void>
}

const readBody = (request: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"))
      } catch {
        resolve({})
      }
    })
  })

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

const now = () => Math.floor(Date.now() / 1000)
const claims = (
  audience: string,
  sessionId: string | null = null,
  clientInstanceId: string | null = null
) => ({
  version: 1,
  issuer: "jingler",
  audience,
  subject: SUBJECT,
  deviceId: audience === "device-control" ? null : DEVICE_ID,
  sessionId,
  clientInstanceId:
    audience === "session-tunnel" || audience === "device-control"
      ? (clientInstanceId ?? "client_e2e_abcdefghijkl")
      : null,
  attachmentGeneration: audience === "session-tunnel" ? 1 : null,
  controllerLeaseGeneration: audience === "session-tunnel" ? 1 : null,
  deviceGeneration: audience === "device-control" ? null : 1,
  issuedAt: now(),
  expiresAt: now() + 300,
  grantId: `grant_${audience.replaceAll("-", "_")}_abcdefgh`
})

export const startFakeDeviceRelay = async (
  options: FakeDeviceRelayOptions
): Promise<FakeDeviceRelay> => {
  let registration: Registration | null = null
  let paired = false
  let state: "online" | "offline" | "incompatible" = "offline"
  let forcedState: "offline" | "incompatible" | null = null
  let catalogOverride: AgentEndpointCatalog | undefined
  let discovery: Record<string, unknown> | null = null
  const endpointRequests: string[] = []
  const pendingCatalogs = new Map<string, { targetId: string; finish: (catalog: unknown) => void }>()
  let claimCount = 0
  let bearerForwarded = false
  let agent: ChildProcess | null = null
  let control: WebSocket | null = null
  let baseUrl = ""
  const tunnels = new Map<string, Tunnel>()

  const startAgent = (): void => {
    if (options.spawnAgentOnClaim === false || (agent && agent.exitCode === null)) return
    mkdirSync(join(options.deviceHome, "jingler"), { recursive: true })
    agent = spawn(
      process.execPath,
      [
        options.deviceAgentBundle,
        "serve",
        "--subject",
        SUBJECT,
        "--device-id",
        DEVICE_ID,
        "--server",
        baseUrl
      ],
      {
        env: {
          ...process.env,
          HOME: options.deviceHome,
          JINGLER_HOME: options.deviceHome,
          JINGLER_DEVICE_RELAY_URL: baseUrl,
          JINGLER_E2E: "1",
          ...(options.piFixture === undefined
            ? {}
            : {
                JINGLER_E2E_PI_FIXTURE: options.piFixture.file,
                JINGLER_E2E_PI_CONNECTION_ID: options.piFixture.connectionId,
                JINGLER_E2E_PI_PROVIDER_ID: options.piFixture.providerId,
                JINGLER_E2E_PI_MODEL_ID: options.piFixture.modelId
              }),
          JINGLER_DISCOVERY_BIN_DIR: options.deviceBinDir,
          PATH: `${options.deviceBinDir}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          ...options.agentEnv
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    agent.stderr?.on("data", (chunk) => {
      if (process.env.JINGLER_E2E_DEVICE_LOG === "1") {
        process.stderr.write(`[device-agent] ${chunk.toString()}`)
      }
    })
  }

  const device = () => {
    const effectiveState = forcedState ?? state
    const announcedCapabilities = deviceCapabilities(discovery)
    return {
      version: 1,
      deviceId: DEVICE_ID,
      accountId: SUBJECT,
      identityFingerprint: "f".repeat(43),
      displayName: registration?.displayName ?? "buildbox",
      platform: registration?.platform ?? { os: "darwin", arch: "arm64" },
      publicKey: registration?.publicKey,
      ...(registration?.encryptionPublicKey
        ? { encryptionPublicKey: registration.encryptionPublicKey }
        : {}),
      capabilities:
        effectiveState === "incompatible"
          ? {
              version: 1,
              capabilities: ["session.observe"],
              maxConcurrentSessions: 1
            }
          : announcedCapabilities ?? registration?.capabilities,
      agentVersion:
        discovery && typeof discovery.agentVersion === "string"
          ? discovery.agentVersion
          : null,
      state: "active",
      generation: 1,
      enrolledAt: now() - 10,
      createdAt: now() - 10,
      updatedAt: now(),
      revokedAt: null,
      presence: {
        version: 1,
        deviceId: DEVICE_ID,
        state: effectiveState === "online" ? "online" : "offline",
        connectedAt: effectiveState === "online" ? now() - 5 : null,
        lastSeenAt: now(),
        activeSessionIds: []
      }
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")

const routes = [
      {
        matches: () => (url.pathname === "/api/auth/get-session"),
        handle: function authSession() {
          return request.headers.authorization === `Bearer ${TOKEN}`
            ? json(response, 200, {
              session: { expiresAt: "2099-01-01T00:00:00Z", token: TOKEN },
              user: {
                id: SUBJECT,
                email: "e2e@jingler.dev",
                name: "E2E User",
                image: null
              }
            })
            : json(response, 401, {})
        }
      },
      {
        matches: () => (url.pathname === "/api/auth/sign-out" && request.method === "POST"),
        handle: function signOut() {
          return json(response, 200, {})
        }
      },
      {
        matches: () => (url.pathname === "/api/devices/enrollment-credentials" &&
          request.method === "POST"),
        handle: async function enrollmentCredential() {
          bearerForwarded ||= request.headers.authorization !== `Bearer ${TOKEN}`
          const body = await readBody(request)
          return json(response, 201, {
            version: 1,
            claim: {
              version: 1,
              claimId: "claim_enrollment_abcdefgh",
              subject: SUBJECT,
              deviceId: DEVICE_ID,
              clientInstanceId:
                typeof body.clientInstanceId === "string"
                  ? body.clientInstanceId
                  : "client_e2e_abcdefghijkl",
              audience: "device-claim",
              issuedAt: now(),
              expiresAt: now() + 300
            },
            token: "e2e-enrollment-token"
          })
        }
      },
      {
        matches: () => (url.pathname === "/api/devices/enrollments/exchange" &&
          request.method === "POST"),
        handle: async function exchangeEnrollment() {
          if (request.headers.authorization !== "Bearer e2e-enrollment-token") {
            return json(response, 401, { error: "invalid enrollment" })
          }
          const body = await readBody(request)
          if (!body.registration || typeof body.registration !== "object") {
            return json(response, 400, { error: "invalid registration" })
          }
          registration = body.registration as unknown as Registration
          paired = true
          forcedState = null
          state = "offline"
          claimCount += 1
          startAgent()
          const { presence: _presence, ...record } = device()
          return json(response, 201, { version: 1, device: record })
        }
      },
      {
        matches: () => (url.pathname === "/v1/pending-devices" && request.method === "POST"),
        handle: async function pendingDevice() {
          registration = (await readBody(request)) as unknown as Registration
          return json(response, 201, {
            version: 1,
            pendingDeviceId: PENDING_ID,
            deviceId: DEVICE_ID,
            pairingCode: PAIRING_CODE,
            expiresAt: now() + 300
          })
        }
      },
      {
        matches: () => (url.pathname === "/api/devices/pairing/claim" && request.method === "POST"),
        handle: async function claimDevice() {
          bearerForwarded ||= request.headers.authorization !== `Bearer ${TOKEN}`
          const body = await readBody(request)
          if (body.pendingDeviceId !== PENDING_ID || body.pairingCode !== PAIRING_CODE || paired)
            return json(response, 409, { error: "invalid claim" })
          paired = true
          forcedState = null
          // Pairing only starts the daemon. Do not advertise it as online until its
          // control WebSocket is actually established: otherwise a desktop can open
          // a session tunnel in this window, the relay drops the session-request,
          // and session creation waits forever.
          state = "offline"
          claimCount += 1
          startAgent()
          return json(response, 200, {
            version: 1,
            subject: SUBJECT,
            device: device()
          })
        }
      },
      {
        matches: () => (url.pathname === "/api/devices" && request.method === "GET"),
        handle: function listDevices() {
          return json(response, 200, {
            version: 1,
            devices: paired ? [device()] : []
          })
        }
      },
      {
        matches: () => (url.pathname === `/api/devices/${DEVICE_ID}/discovery` && request.method === "POST"),
        handle: async function refreshEndpoints() {
          const body = await readBody(request)
          if (!control || typeof body.targetId !== "string") return json(response, 503, { error: "offline" })
          const requestId = `catalog-${endpointRequests.length + 1}`
          endpointRequests.push(String(body.action))
          const catalog = await new Promise<unknown>((resolve) => {
            const timer = setTimeout(() => { pendingCatalogs.delete(requestId); resolve(null) }, 10_000)
            pendingCatalogs.set(requestId, { targetId: body.targetId as string, finish: (value) => {
              clearTimeout(timer); pendingCatalogs.delete(requestId); resolve(value)
            } })
            control!.send(JSON.stringify({ type: "endpoint-catalog-request", version: 1, requestId, ...body }))
          })
          if (!catalog) return json(response, 504, { error: "timeout" })
          discovery = { ...discovery, capabilities: { ...deviceCapabilities(discovery), endpointCatalog: catalog } }
          return json(response, 200, { version: 1, deviceId: DEVICE_ID, discovery, updatedAt: now() })
        }
      },
      {
        matches: () => (url.pathname === `/api/devices/${DEVICE_ID}/discovery` && request.method === "GET"),
        handle: function discoverDevice() {
          return json(response, 200, {
            version: 1,
            deviceId: DEVICE_ID,
            discovery,
            updatedAt: discovery ? now() : null
          })
        }
      },
      {
        matches: () => (url.pathname === "/api/devices/grants" && request.method === "POST"),
        handle: async function grantDevice() {
          const body = await readBody(request)
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : null
          const clientInstanceId =
            typeof body.clientInstanceId === "string" ? body.clientInstanceId : null
          recordTunnelGrant(sessionId, clientInstanceId, body, tunnels)
          return json(response, 200, {
            version: 1,
            relayUrl: baseUrl,
            grant: `session-${sessionId}`,
            claims: claims("session-tunnel", sessionId, clientInstanceId)
          })
        }
      },
      {
        matches: () => (url.pathname === "/api/devices/challenges" && request.method === "POST"),
        handle: function challengeDevice() {
          return json(response, 200, {
            version: 1,
            challengeId: "challenge_abcdefgh",
            subject: SUBJECT,
            deviceId: DEVICE_ID,
            nonce: "abcdefghijklmnopqrstuv",
            issuedAt: now(),
            expiresAt: now() + 60
          })
        }
      },
      {
        matches: () => (url.pathname === "/api/devices/challenges/exchange" && request.method === "POST"),
        handle: function exchangeChallenge() {
          return json(response, 200, {
            version: 1,
            relayUrl: baseUrl,
            grant: "device-connect-grant",
            claims: claims("device-connect")
          })
        }
      },
      {
        matches: () => (url.pathname === `/api/devices/${DEVICE_ID}/revoke` && request.method === "POST"),
        handle: function revokeDevice() {
          paired = false
          state = "offline"
          control?.close(4003, "revoked")
          for (const tunnel of tunnels.values()) {
            tunnel.desktop?.close(4003, "revoked")
            tunnel.device?.close(4003, "revoked")
          }
          return json(response, 200, { version: 1, revoked: true })
        }
      },
      {
        matches: () => (url.pathname === `/api/devices/${DEVICE_ID}/rename` && request.method === "POST"),
        handle: async function renameDevice() {
          const body = await readBody(request)
          if (registration && typeof body.displayName === "string")
            registration = { ...registration, displayName: body.displayName }
          return json(response, 200, { version: 1, device: device() })
        }
      }
    ];
const route = routes.find((candidate) => candidate.matches());
if (route) return route.handle();

    json(response, 404, { error: "not found" })
  })

  const sockets = new WebSocketServer({ noServer: true })
  const receiveControlMessage = (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>
    if (process.env.JINGLER_E2E_DEVICE_LOG === "1") {
      process.stderr.write(`[device-control] ${JSON.stringify(message)}\n`)
    }
    if (message.type === "endpoint-catalog-update" && typeof message.requestId === "string") {
      const pending = pendingCatalogs.get(message.requestId)
      if (pending?.targetId === message.targetId) pending.finish(catalogOverride ?? message.catalog)
    }
    if (
      message.type === "announce" &&
      message.discovery &&
      typeof message.discovery === "object"
    )
      discovery = message.discovery as Record<string, unknown>
  }

  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      const url = new URL(request.url ?? "/", baseUrl)
      if (url.pathname === "/v1/device-connect") {
        control = websocket
        if (forcedState === null) state = "online"
        websocket.on("message", receiveControlMessage)
        websocket.on("close", () => {
          if (control === websocket) {
            control = null
            if (forcedState === null) state = "offline"
          }
        })
        return
      }
      return connectSessionTunnel(url, websocket, tunnels, baseUrl, () => control)
})
  })

  await new Promise<void>((resolve) =>
    server.listen(0, options.listenHost ?? "127.0.0.1", resolve)
  )
  baseUrl = `http://${options.publicHost ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}`

  return {
    url: baseUrl,
    token: TOKEN,
    deviceHome: options.deviceHome,
    setEndpointCatalog: (catalog) => { catalogOverride = catalog },
    ready: () => {
      const capabilities = deviceCapabilities(discovery) as {
        runtime?: { targetId?: unknown }
        providerConnections?: ReadonlyArray<{ id?: unknown; status?: unknown }>
      } | undefined
      return state === "online" &&
        capabilities?.runtime?.targetId === DEVICE_ID &&
        capabilities.providerConnections?.some((connection) =>
          connection.id === options.piFixture?.connectionId && connection.status === "authenticated"
        ) === true
    },
    endpointRequests: () => [...endpointRequests],
    sshClaims: () => claimCount,
    desktopBearerForwarded: () => bearerForwarded,
    commandAdmissions: (sessionId, operation) => {
      try {
        const ledger = JSON.parse(
          readFileSync(
            join(options.deviceHome, "jingler", "device", "sessions", `${sessionId}.json`),
            "utf8"
          )
        ) as {
          commands?: Record<string, { command?: { operation?: string } }>
        }
        const commands = Object.values(ledger.commands ?? {})
        return operation === undefined
          ? commands.length
          : commands.filter((entry) => entry.command?.operation === operation).length
      } catch {
        return 0
      }
    },
    interruptSession: (sessionId) => {
      const tunnel = tunnels.get(sessionId)
      tunnel?.desktop?.close(1012, "e2e interruption")
      tunnel?.device?.close(1012, "e2e interruption")
    },
    setDeviceState: (next) => {
      forcedState = next === "online" ? null : next
      state = next
      if (next !== "online") control?.close(1012, next)
    },
    close: async () => {
      for (const client of sockets.clients) client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (agent && agent.exitCode === null) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 2_000)
          agent!.once("exit", () => {
            clearTimeout(timeout)
            resolve()
          })
          agent!.kill("SIGTERM")
        })
      }
    }
  }
}

function receiveTunnelEnvelope(sessionId: string, endpoint: string, tunnel: Tunnel, websocket: WebSocket): (this: WebSocket, data: WebSocket.RawData, isBinary: boolean) => void {
  return (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>
    if (process.env.JINGLER_E2E_DEVICE_LOG === "1") {
      process.stderr.write(
        `[session-tunnel] ${sessionId} ${endpoint} ${String(message.type)}\n`
      )
    }
    if (message.type !== "envelope" ||
      !message.envelope ||
      typeof message.envelope !== "object")
      return
    const envelope = message.envelope as Record<string, unknown>
    const duplicate = tunnel.envelopes.some(
      (candidate) => candidate.sender === envelope.sender && candidate.sequence === envelope.sequence
    )
    if (!duplicate) tunnel.envelopes.push(envelope)
    websocket.send(
      JSON.stringify({
        type: "envelope-result",
        sequence: envelope.sequence,
        status: duplicate ? "duplicate" : "inserted"
      })
    )
    const peer = endpoint === "desktop" ? tunnel.device : tunnel.desktop
    if (!duplicate && peer?.readyState === WebSocket.OPEN)
      peer.send(JSON.stringify({ type: "envelope", envelope }))
  }
}

function connectSessionTunnel(url: URL, websocket: WebSocket, tunnels: Map<string, Tunnel>, baseUrl: string, getControl: () => WebSocket | null) {
  const match = /^\/v1\/session-tunnels\/([^/]+)$/u.exec(url.pathname)
  if (!match) return websocket.close(1008, "unknown endpoint")
  const sessionId = decodeURIComponent(match[1]!)
  const endpoint = url.searchParams.get("endpoint") === "device" ? "device" : "desktop"
  if (process.env.JINGLER_E2E_DEVICE_LOG === "1") {
    process.stderr.write(`[session-tunnel] open ${sessionId} ${endpoint}\n`)
  }
  const acknowledged = Number(url.searchParams.get("acknowledgedSequence") ?? "0")
  const tunnel = tunnels.get(sessionId) ?? { envelopes: [] }
  tunnels.set(sessionId, tunnel)
  const replaced = tunnel[endpoint]
  if (replaced?.readyState === WebSocket.OPEN) {
    replaced.close(4002, "Connection replaced")
  }
  tunnel[endpoint] = websocket
  const newestOutgoingSequence = tunnel.envelopes
    .filter((envelope) => envelope.sender === endpoint)
    .reduce((latest, envelope) => Math.max(latest, Number(envelope.sequence) || 0), 0)
  websocket.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      endpoint,
      sessionId,
      acknowledgedSequence: acknowledged,
      nextSequence: newestOutgoingSequence + 1
    })
  )
  if (endpoint === "desktop") {
    const encodedOffer = url.searchParams.get("keyOffer")
    tunnel.keyOffer = encodedOffer
      ? JSON.parse(Buffer.from(encodedOffer, "base64url").toString("utf8"))
      : tunnel.keyOffer
    queueMicrotask(() => {
      if (process.env.JINGLER_E2E_DEVICE_LOG === "1") {
        process.stderr.write(`[device-control] send session-request ${sessionId}\n`)
      }
      getControl()?.send(
        JSON.stringify({
          type: "session-request",
          relayUrl: baseUrl,
          sessionId,
          grant: `device-${sessionId}`,
          keyOffer: tunnel.keyOffer,
          clientInstanceId:
            tunnel.clientInstanceId ?? "client_e2e_abcdefghijkl",
          attachmentGeneration: tunnel.attachmentGeneration ?? 1,
          controllerLeaseGeneration: tunnel.controllerLeaseGeneration ?? 1
        })
      )
    })
  }
  for (const envelope of tunnel.envelopes) {
    if (envelope.sender !== endpoint && Number(envelope.sequence) > acknowledged)
      websocket.send(JSON.stringify({ type: "envelope", envelope }))
  }
  websocket.on("message", receiveTunnelEnvelope(sessionId, endpoint, tunnel, websocket))
}

function deviceCapabilities(discovery: Record<string, unknown> | null) {
  return discovery?.capabilities !== null &&
    typeof discovery?.capabilities === "object"
    ? discovery.capabilities
    : undefined
}

function recordTunnelGrant(sessionId: string | null, clientInstanceId: string | null, body: Record<string, unknown>, tunnels: Map<string, Tunnel>) {
  if (sessionId) {
    const tunnel = tunnels.get(sessionId) ?? { envelopes: [] }
    tunnel.clientInstanceId = clientInstanceId ?? "client_e2e_abcdefghijkl"
    tunnel.attachmentGeneration =
      typeof body.attachmentGeneration === "number" ? body.attachmentGeneration : 1
    tunnel.controllerLeaseGeneration =
      typeof body.controllerLeaseGeneration === "number"
        ? body.controllerLeaseGeneration
        : 1
    tunnels.set(sessionId, tunnel)
  }
}
