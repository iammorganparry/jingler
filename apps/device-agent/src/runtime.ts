import { hostname, homedir } from "node:os"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
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
  runControlConnection
} from "./control-connection.js"
import {
  exchangeDeviceEnrollment,
  type DeviceEnrollment,
  type ExchangeDeviceEnrollmentDependencies
} from "./device-client.js"
import {
  loadOrCreateDeviceIdentity,
  rotateDeviceIdentity
} from "./device-identity.js"
import { SessionCommandHandler, type SessionCommandExecutor } from "./session-handler.js"
import { runDeviceSessionTunnel } from "./session-tunnel.js"
import { makeLiveDeviceSessionCommandExecutor } from "./device-executor.js"
import { startDirectSessionServer } from "./direct-session-server.js"

export const DEVICE_AGENT_VERSION = packageJson.version

export interface DeviceAgentPaths {
  readonly jinglerRoot: string
  readonly deviceDir: string
  readonly identityFile: string
  readonly enrollmentFile: string
  readonly directSessionSocketFile: string
}

export const deviceAgentPaths = (): DeviceAgentPaths => {
  const root = join(process.env.JINGLER_HOME ?? homedir(), "jingler")
  const deviceDir = join(root, "device")
  return {
    jinglerRoot: root,
    deviceDir,
    identityFile: join(deviceDir, "identity.json"),
    enrollmentFile: join(deviceDir, "enrollment.json"),
    directSessionSocketFile: join(deviceDir, "direct-session.socket")
  }
}

const publishDirectSessionSocket = async (
  paths: DeviceAgentPaths,
  socketPath: string
): Promise<void> => {
  await mkdir(paths.deviceDir, { recursive: true, mode: 0o700 })
  await chmod(paths.deviceDir, 0o700)
  const temporary = `${paths.directSessionSocketFile}.${process.pid}.next`
  await rm(temporary, { force: true })
  await writeFile(temporary, `${socketPath}\n`, { mode: 0o600, flag: "wx" })
  try {
    await rename(temporary, paths.directSessionSocketFile)
    await chmod(paths.directSessionSocketFile, 0o600)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

const clearDirectSessionSocket = async (
  paths: DeviceAgentPaths,
  socketPath: string
): Promise<void> => {
  try {
    const publishedPath = (await readFile(paths.directSessionSocketFile, "utf8")).trim()
    if (publishedPath === socketPath) {
      await rm(paths.directSessionSocketFile, { force: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export const persistEnrollment = async (
  paths: DeviceAgentPaths,
  enrollment: DeviceEnrollment
): Promise<void> => {
  await mkdir(paths.deviceDir, { recursive: true, mode: 0o700 })
  await chmod(paths.deviceDir, 0o700)
  const temporary = `${paths.enrollmentFile}.${process.pid}.next`
  await rm(temporary, { force: true })
  await writeFile(temporary, `${JSON.stringify(enrollment)}\n`, {
    mode: 0o600,
    flag: "wx"
  })
  try {
    await chmod(temporary, 0o600)
    await rename(temporary, paths.enrollmentFile)
    await chmod(paths.enrollmentFile, 0o600)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
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

export interface EnrollOwnedDeviceInput {
  readonly serverUrl: string
  readonly credential: unknown
  readonly displayName?: string
}

/** Exchange the invisible bootstrap credential and persist only renewable identity metadata. */
export const enrollOwnedDevice = async (
  input: EnrollOwnedDeviceInput,
  paths = deviceAgentPaths(),
  dependencies?: ExchangeDeviceEnrollmentDependencies
): Promise<{ readonly version: 1; readonly deviceId: string; readonly displayName: string }> => {
  const identity = await Effect.runPromise(loadOrCreateDeviceIdentity(paths.identityFile))
  const discovery = await Effect.runPromise(
    discoverLiveDeviceCapabilities(paths.jinglerRoot, DEVICE_AGENT_VERSION)
  )
  const displayName = input.displayName?.trim() || hostname()
  const result = await exchangeDeviceEnrollment(
    {
      serverUrl: input.serverUrl,
      credential: input.credential,
      registration: {
        version: 1,
        displayName,
        platform: discovery.platform,
        publicKey: identity.publicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        capabilities: discovery.capabilities,
        agentVersion: DEVICE_AGENT_VERSION
      }
    },
    dependencies
  )
  await persistEnrollment(paths, result.enrollment)
  return { version: 1, deviceId: result.device.deviceId, displayName: result.device.displayName }
}

export interface ServeDeviceInput {
  readonly subject?: string
  readonly deviceId?: string
  readonly serverUrl?: string
  readonly signal: AbortSignal
  /** Test/embedding seam; production operations are installed by the device runtime. */
  readonly sessionExecutor?: SessionCommandExecutor
}

/** Own every detached session fiber so daemon shutdown also closes session sockets. */
export class DeviceSessionTasks {
  readonly #controllers = new Set<AbortController>()
  readonly #tasks = new Set<Promise<void>>()

  run(effect: Effect.Effect<void, unknown>): Promise<void> {
    const controller = new AbortController()
    this.#controllers.add(controller)
    const task = Effect.runPromise(effect, { signal: controller.signal }).finally(() => {
      this.#controllers.delete(controller)
      this.#tasks.delete(task)
    })
    this.#tasks.add(task)
    return task
  }

  async stop(): Promise<void> {
    for (const controller of this.#controllers) controller.abort()
    await Promise.allSettled([...this.#tasks])
  }
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
  const sessionTasks = new DeviceSessionTasks()
  const handlerFor = (sessionId: string): SessionCommandHandler => {
    const handler = sessionHandlers.get(sessionId) ?? new SessionCommandHandler(
      join(paths.deviceDir, "sessions", `${sessionId}.json`),
      executor
    )
    sessionHandlers.set(sessionId, handler)
    return handler
  }
  const directServer = await startDirectSessionServer({
    enrollment,
    identity,
    handlerFor
  })
  try {
    await publishDirectSessionSocket(paths, directServer.socketPath)
  } catch (error) {
    await directServer.close()
    throw error
  }
  try {
    return await runControlConnection(
      {
        refreshGrant: createDeviceGrantRefresher(enrollment, identity),
        connect: connectDeviceWebSocket,
        discover: () =>
          Effect.runPromise(
            discoverLiveDeviceCapabilities(paths.jinglerRoot, DEVICE_AGENT_VERSION)
          ),
        sleep: abortableSleep,
        handleSessionRequest: (request) => {
          const handler = handlerFor(request.sessionId)
          return sessionTasks.run(
            runDeviceSessionTunnel(request, enrollment, identity, handler)
          )
        }
      },
      input.signal
    )
  } finally {
    await Promise.all([
      clearDirectSessionSocket(paths, directServer.socketPath),
      directServer.close(),
      sessionTasks.stop()
    ])
  }
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
