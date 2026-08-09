import type {
  AccountDevice,
  DeviceEnrollmentCredentialResponse,
  DeviceRelayGrantResponse,
  Environment,
  EnvironmentDiscovery,
  PairSshEnvironmentInput,
  RemoteDevice
} from "@jingler/core"
import {
  AccountDeviceListResponse as AccountDeviceListResponseSchema,
  DeviceEnrollmentCredentialResponse as DeviceEnrollmentCredentialResponseSchema,
  DeviceRecord as DeviceRecordSchema,
  DeviceRelayGrantResponse as DeviceRelayGrantResponseSchema,
  EnvironmentError,
  EnvironmentDiscovery as EnvironmentDiscoverySchema,
  REMOTE_PROTOCOL_VERSION
} from "@jingler/core"
import { Effect, Schema } from "effect"
import type { DirectSshTarget } from "./device-secret-document.js"
import {
  readDeviceSecretDocument,
  updateDeviceSecretDocument
} from "./device-secret-document.js"
import { RemoteBootstrapService } from "./remote-bootstrap.js"
import { SecretStore } from "./secret-store.js"

const authBaseUrl = (): string => process.env.JINGLER_AUTH_URL ?? "http://localhost:9100"
const deviceAgentBundlePath = (): string | undefined => process.env.JINGLER_DEVICE_AGENT_BUNDLE
const DEVICE_API_ROOT = "/api/devices"

type EnvironmentDevice = RemoteDevice | AccountDevice

export const environmentFromRemoteDevice = (device: EnvironmentDevice): Environment => ({
  id: device.deviceId,
  name: device.displayName,
  platform: device.platform,
  capabilities: device.capabilities,
  state:
    device.state === "revoked"
      ? "revoked"
      : !device.capabilities.capabilities.includes("session.start")
        ? "incompatible"
        : device.presence.state,
  agentVersion: "agentVersion" in device ? device.agentVersion ?? null : null,
  lastSeenAt: device.presence.lastSeenAt
})

const environmentError = (status: number, fallback: string): EnvironmentError =>
  new EnvironmentError({
    reason:
      status === 401
        ? "authentication"
        : status === 404
          ? "not-found"
          : status === 409 || status === 410
            ? "expired-code"
            : "unavailable",
    message: fallback
  })

export class EnvironmentService extends Effect.Service<EnvironmentService>()(
  "@jingler/EnvironmentService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const secrets = yield* SecretStore
      const bootstrap = yield* RemoteBootstrapService
      const clientInstanceId = yield* Effect.tryPromise({
        try: async () => {
          const document = await updateDeviceSecretDocument(secrets, (current) => {
            if (
              typeof current.clientInstanceId === "string" &&
              /^client_[A-Za-z0-9_-]{8,120}$/u.test(current.clientInstanceId)
            ) {
              return current
            }
            return {
              ...current,
              clientInstanceId: `client_${crypto.randomUUID().replaceAll("-", "")}`
            }
          })
          return document.clientInstanceId!
        },
        catch: () => environmentError(503, "The device identity store is unavailable.")
      })

      const request = <A, I>(
        path: string,
        schema: Schema.Schema<A, I>,
        init?: RequestInit
      ): Effect.Effect<A, EnvironmentError> =>
        Effect.gen(function* () {
          const token = yield* secrets.get
          if (!token) {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "authentication",
                message: "Sign in to manage devices."
              })
            )
          }
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${authBaseUrl()}${path}`, {
                ...init,
                headers: {
                  authorization: `Bearer ${token}`,
                  "x-jingler-client-instance-id": clientInstanceId,
                  ...(init?.body ? { "content-type": "application/json" } : {})
                }
              }),
            catch: () => environmentError(503, "The device service is unavailable.")
          })
          if (!response.ok) {
            return yield* Effect.fail(
              environmentError(response.status, "The device request failed.")
            )
          }
          const body = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () => environmentError(502, "The device service returned an invalid response.")
          })
          return yield* Schema.decodeUnknown(schema)(body).pipe(
            Effect.mapError(() =>
              environmentError(502, "The device service returned an invalid response.")
            )
          )
        })

      const accountDevices = () => request(DEVICE_API_ROOT, AccountDeviceListResponseSchema)

      const list = Effect.gen(function* () {
        const response = yield* accountDevices()
        return response.devices.map(environmentFromRemoteDevice)
      })

      const device = (
        deviceId: string
      ): Effect.Effect<EnvironmentDevice, EnvironmentError> =>
        accountDevices().pipe(
          Effect.flatMap((response) => {
            const found = response.devices.find((candidate) => candidate.deviceId === deviceId)
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                  new EnvironmentError({
                    reason: "not-found",
                    message: "The selected device is no longer available."
                  })
                )
          })
        )

      const sessionGrant = (
        deviceId: string,
        sessionId: string
      ): Effect.Effect<DeviceRelayGrantResponse, EnvironmentError> =>
        request(`${DEVICE_API_ROOT}/grants`, DeviceRelayGrantResponseSchema, {
          method: "POST",
          body: JSON.stringify({
            version: REMOTE_PROTOCOL_VERSION,
            audience: "session-tunnel",
            deviceId,
            sessionId,
            clientInstanceId,
            attachmentGeneration: null,
            controllerLeaseGeneration: null
          })
        })

      const enrollmentCredential = (
        deviceId: string
      ): Effect.Effect<DeviceEnrollmentCredentialResponse, EnvironmentError> =>
        request(`${DEVICE_API_ROOT}/enrollment-credentials`, DeviceEnrollmentCredentialResponseSchema, {
          method: "POST",
          body: JSON.stringify({
            version: REMOTE_PROTOCOL_VERSION,
            deviceId,
            clientInstanceId
          })
        })

      const pairSsh = (input: PairSshEnvironmentInput) =>
        Effect.gen(function* () {
          const agentBundlePath = deviceAgentBundlePath()
          if (!agentBundlePath) {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "unavailable",
                message: "The device agent bundle is unavailable."
              })
            )
          }
          const deviceId = `device_${crypto.randomUUID().replaceAll("-", "")}`
          const credential = yield* enrollmentCredential(deviceId)
          const enrolled = yield* bootstrap.installAndEnroll({
            host: input.host,
            ...(input.username === undefined ? {} : { username: input.username }),
            ...(input.port === undefined ? {} : { port: input.port }),
            agentBundlePath,
            serverUrl: authBaseUrl(),
            credential
          }).pipe(
            Effect.mapError(
              (error) =>
                new EnvironmentError({
                  reason: error.kind === "incompatible" ? "incompatible" : "ssh",
                  message: error.message
                })
            )
          )
          const response = yield* accountDevices()
          const registered = response.devices.find(
            (candidate) => candidate.deviceId === enrolled.deviceId
          )
          if (!registered) {
            return yield* Effect.fail(
              environmentError(502, "The enrolled device was not returned by the registry.")
            )
          }
          yield* Effect.tryPromise({
            try: () => updateDeviceSecretDocument(secrets, (document) => ({
              ...document,
              directSshTargets: {
                ...document.directSshTargets,
                [registered.deviceId]: {
                  host: input.host,
                  ...(input.username === undefined ? {} : { username: input.username }),
                  ...(input.port === undefined ? {} : { port: input.port })
                }
              }
            })),
            catch: () => environmentError(503, "The SSH connection could not be saved.")
          })
          return environmentFromRemoteDevice(registered)
        })

      const directSsh = (
        deviceId: string
      ): Effect.Effect<DirectSshTarget | null, EnvironmentError> =>
        Effect.tryPromise({
          try: async () => {
            const target = (await readDeviceSecretDocument(secrets)).directSshTargets?.[deviceId]
            if (!target || typeof target.host !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/u.test(target.host)) return null
            if (target.username !== undefined && !/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/u.test(target.username)) return null
            if (target.port !== undefined && (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65_535)) return null
            return target
          },
          catch: () => environmentError(503, "The saved SSH connection is unavailable.")
        })

      const rename = (deviceId: string, name: string) =>
        Effect.gen(function* () {
          const trimmed = name.trim()
          if (!trimmed) {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "invalid-input",
                message: "Enter a device name."
              })
            )
          }
          const result = yield* request(
            `${DEVICE_API_ROOT}/${encodeURIComponent(deviceId)}/rename`,
            Schema.Struct({
              version: Schema.Literal(1),
              device: Schema.Unknown
            }),
            {
              method: "POST",
              body: JSON.stringify({
                version: 1,
                deviceId,
                displayName: trimmed
              })
            }
          )
          const device = yield* Schema.decodeUnknown(DeviceRecordSchema)(result.device).pipe(
            Effect.mapError(() =>
              environmentError(502, "The device service returned an invalid response.")
            )
          )
          const current = yield* accountDevices()
          const joined = current.devices.find((candidate) => candidate.deviceId === device.deviceId)
          const fallback: Environment = {
                id: device.deviceId,
                name: device.displayName,
                platform: device.platform,
                capabilities: device.capabilities,
                state: device.state === "revoked" ? "revoked" : "offline",
                agentVersion: null,
                lastSeenAt: null
              }
          return joined ? environmentFromRemoteDevice(joined) : fallback
        })

      const revoke = (deviceId: string) =>
        Effect.gen(function* () {
          yield* request(`${DEVICE_API_ROOT}/${encodeURIComponent(deviceId)}/revoke`, Schema.Unknown, {
            method: "POST"
          })
          yield* Effect.tryPromise({
            try: () => updateDeviceSecretDocument(secrets, (document) => {
              if (!document.directSshTargets?.[deviceId]) return document
              const directSshTargets = { ...document.directSshTargets }
              delete directSshTargets[deviceId]
              return { ...document, directSshTargets }
            }),
            catch: () => environmentError(503, "The saved SSH connection could not be removed.")
          })
        }).pipe(Effect.asVoid)

      const discovery = (deviceId: string): Effect.Effect<EnvironmentDiscovery, EnvironmentError> =>
        request(
          `${DEVICE_API_ROOT}/${encodeURIComponent(deviceId)}/discovery`,
          EnvironmentDiscoverySchema
        )

      return {
        list,
        device,
        sessionGrant,
        discovery,
        refresh: list,
        suggestHosts: bootstrap.discoverHosts,
        pairSsh,
        directSsh,
        rename,
        revoke
      } as const
    })
  }
) {}
