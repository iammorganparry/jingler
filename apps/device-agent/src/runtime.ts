import { hostname, homedir } from "node:os"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { PendingDeviceRegistrationResponse } from "@jingler/core"
import { PendingDeviceRegistrationResponse as PendingDeviceRegistrationResponseSchema } from "@jingler/core"
import { Effect, Schema } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { discoverLiveDeviceCapabilities } from "./capabilities.js"
import {
  abortableSleep,
  connectDeviceWebSocket,
  createDeviceGrantRefresher,
  type DeviceEnrollment,
  runControlConnection
} from "./control-connection.js"
import {
  loadOrCreateDeviceIdentity,
  rotateDeviceIdentity
} from "./device-identity.js"
import { SessionCommandHandler, type SessionCommandExecutor } from "./session-handler.js"
import { runDeviceSessionTunnel } from "./session-tunnel.js"
import { makeLiveDeviceSessionCommandExecutor } from "./device-executor.js"

export const DEVICE_AGENT_VERSION = packageJson.version

export interface DeviceAgentPaths {
  readonly jinglerRoot: string
  readonly deviceDir: string
  readonly identityFile: string
  readonly enrollmentFile: string
}

export const deviceAgentPaths = (): DeviceAgentPaths => {
  const root = join(process.env.JINGLER_HOME ?? homedir(), "jingler")
  const deviceDir = join(root, "device")
  return {
    jinglerRoot: root,
    deviceDir,
    identityFile: join(deviceDir, "identity.json"),
    enrollmentFile: join(deviceDir, "enrollment.json")
  }
}

const persistEnrollment = async (
  paths: DeviceAgentPaths,
  enrollment: DeviceEnrollment
): Promise<void> => {
  await mkdir(paths.deviceDir, { recursive: true, mode: 0o700 })
  await chmod(paths.deviceDir, 0o700)
  await writeFile(paths.enrollmentFile, `${JSON.stringify(enrollment)}\n`, {
    mode: 0o600,
    flag: "w"
  })
  await chmod(paths.enrollmentFile, 0o600)
}

const readEnrollment = async (paths: DeviceAgentPaths): Promise<DeviceEnrollment | null> => {
  try {
    const value: unknown = JSON.parse(await readFile(paths.enrollmentFile, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const record = Object.fromEntries(Object.entries(value))
    return typeof record.subject === "string" &&
      typeof record.deviceId === "string" &&
      typeof record.serverUrl === "string"
      ? { subject: record.subject, deviceId: record.deviceId, serverUrl: record.serverUrl }
      : null
  } catch {
    return null
  }
}

const relayEndpoint = (relayUrl: string): string =>
  `${relayUrl.replace(/\/$/u, "")}/v1/pending-devices`

export const registerPendingDevice = async (
  relayUrl: string,
  paths: DeviceAgentPaths,
  displayName = hostname()
): Promise<PendingDeviceRegistrationResponse> => {
  const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(paths.identityFile))
  const discovery = await Effect.runPromise(
    discoverLiveDeviceCapabilities(paths.jinglerRoot, DEVICE_AGENT_VERSION)
  )
  const response = await fetch(relayEndpoint(relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      version: 1,
      displayName,
      platform: discovery.platform,
      publicKey: identity.publicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
      capabilities: discovery.capabilities
    })
  })
  if (!response.ok) throw new Error(`Device relay returned ${response.status}`)
  return Schema.decodeUnknownSync(PendingDeviceRegistrationResponseSchema)(await response.json(), {
    onExcessProperty: "error"
  })
}

export interface ServeDeviceInput {
  readonly subject?: string
  readonly deviceId?: string
  readonly serverUrl?: string
  readonly signal: AbortSignal
  /** Test/embedding seam; production operations are installed by the device runtime. */
  readonly sessionExecutor?: SessionCommandExecutor
}

export const serveDevice = async (
  input: ServeDeviceInput,
  paths = deviceAgentPaths()
): Promise<"stopped" | "revoked"> => {
  const existing = await readEnrollment(paths)
  const enrollment =
    input.subject && input.deviceId && input.serverUrl
      ? { subject: input.subject, deviceId: input.deviceId, serverUrl: input.serverUrl }
      : existing
  if (!enrollment) {
    throw new Error("Device is not activated; pass --subject, --device-id and --server once")
  }
  if (input.subject && input.deviceId && input.serverUrl) {
    await persistEnrollment(paths, enrollment)
  }
  const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(paths.identityFile))
  const executor: SessionCommandExecutor =
    input.sessionExecutor ?? makeLiveDeviceSessionCommandExecutor(paths.jinglerRoot)
  const sessionHandlers = new Map<string, SessionCommandHandler>()
  return runControlConnection(
    {
      refreshGrant: createDeviceGrantRefresher(enrollment, identity),
      connect: connectDeviceWebSocket,
      discover: () =>
        Effect.runPromise(
          discoverLiveDeviceCapabilities(paths.jinglerRoot, DEVICE_AGENT_VERSION)
        ),
      sleep: abortableSleep,
      handleSessionRequest: async (request) => {
        const handler = sessionHandlers.get(request.sessionId) ?? new SessionCommandHandler(
          join(paths.deviceDir, "sessions", `${request.sessionId}.json`),
          executor
        )
        sessionHandlers.set(request.sessionId, handler)
        await Effect.runPromise(
          runDeviceSessionTunnel(request, enrollment, identity, handler)
        )
      }
    },
    input.signal
  )
}

export const deviceStatus = async (paths = deviceAgentPaths()) => {
  const enrollment = await readEnrollment(paths)
  const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(paths.identityFile))
  return {
    version: 1,
    agentVersion: DEVICE_AGENT_VERSION,
    state: enrollment ? "paired" : "unpaired",
    deviceId: enrollment?.deviceId ?? null,
    subject: enrollment?.subject ?? null,
    publicKey: identity.publicKey
  } as const
}

export const revokeLocalDevice = async (paths = deviceAgentPaths()): Promise<void> => {
  await rm(paths.enrollmentFile, { force: true })
}

export const rotateLocalDeviceKey = async (paths = deviceAgentPaths()) => {
  if (await readEnrollment(paths)) {
    throw new Error("Revoke or complete server-authorized key rotation before replacing a paired key")
  }
  return (await Effect.runPromise(rotateDeviceIdentity(paths.identityFile))).publicKey
}
