import type {
  DeviceRelayGrantResponse,
  Environment,
  EnvironmentDiscovery,
  PairLinkEnvironmentInput,
  PairSshEnvironmentInput,
  PairingClaimResponse,
  RemoteDevice
} from "@jingler/core"
import {
  DeviceListResponse as DeviceListResponseSchema,
  DeviceRelayGrantResponse as DeviceRelayGrantResponseSchema,
  EnvironmentError,
  PairingClaimResponse as PairingClaimResponseSchema,
  EnvironmentDiscovery as EnvironmentDiscoverySchema,
  RemoteDevice as RemoteDeviceSchema,
  REMOTE_PROTOCOL_VERSION
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { RemoteBootstrapService } from "./remote-bootstrap.js"
import { SecretStore } from "./secret-store.js"

const authBaseUrl = (): string => process.env.JINGLER_AUTH_URL ?? "http://localhost:9100"
const relayUrl = (): string | undefined => process.env.JINGLER_DEVICE_RELAY_URL
const deviceAgentBundlePath = (): string | undefined => process.env.JINGLER_DEVICE_AGENT_BUNDLE
const DEVICE_API_ROOT = "/api/devices"

export const environmentFromRemoteDevice = (device: RemoteDevice): Environment => ({
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
  agentVersion: device.agentVersion ?? null,
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

      const list = Effect.gen(function* () {
        const response = yield* request(DEVICE_API_ROOT, DeviceListResponseSchema)
        return response.devices.map(environmentFromRemoteDevice)
      })

      const device = (deviceId: string) =>
        request(DEVICE_API_ROOT, DeviceListResponseSchema).pipe(
          Effect.flatMap((response) => {
            const found = response.devices.find((candidate) => candidate.deviceId === deviceId)
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                  new EnvironmentError({
                    reason: "not-found",
                    message: "The selected device is no longer paired."
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
            sessionId
          })
        })

      const claim = (pendingDeviceId: string, pairingCode: string) =>
        request(`${DEVICE_API_ROOT}/pairing/claim`, PairingClaimResponseSchema, {
          method: "POST",
          body: JSON.stringify({
            version: REMOTE_PROTOCOL_VERSION,
            pendingDeviceId,
            pairingCode
          })
        }) as Effect.Effect<PairingClaimResponse, EnvironmentError>

      const pairLink = (input: PairLinkEnvironmentInput) =>
        Effect.gen(function* () {
          let provided: URL
          let expected: URL
          try {
            provided = new URL(input.backendUrl)
            expected = new URL(authBaseUrl())
          } catch {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "invalid-input",
                message: "Enter a valid backend URL."
              })
            )
          }
          if (provided.origin !== expected.origin) {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "invalid-input",
                message: "The pairing link must use this Jingler account server."
              })
            )
          }
          return environmentFromRemoteDevice(
            (yield* claim(input.pendingDeviceId, input.pairingCode)).device
          )
        })

      const pairSsh = (input: PairSshEnvironmentInput) => {
        const connection = {
          host: input.host,
          ...(input.username === undefined ? {} : { username: input.username }),
          ...(input.port === undefined ? {} : { port: input.port }),
          ...(relayUrl() === undefined ? {} : { relayUrl: relayUrl() })
        }
        return bootstrap
          .bootstrap(connection)
          .pipe(
            Effect.catchAll((error) => {
              const agentBundlePath = deviceAgentBundlePath()
              return error.kind === "incompatible" && agentBundlePath
                ? bootstrap.installAndBootstrap({
                    ...connection,
                    agentBundlePath
                  })
                : Effect.fail(error)
            })
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new EnvironmentError({
                  reason: error.kind === "incompatible" ? "incompatible" : "ssh",
                  message: error.message
                })
            ),
            Effect.flatMap((pending) => claim(pending.pendingDeviceId, pending.pairingCode)),
            Effect.flatMap((claimed) =>
              bootstrap
                .activate({
                  ...connection,
                  subject: claimed.subject,
                  deviceId: claimed.device.deviceId,
                  serverUrl: authBaseUrl()
                })
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new EnvironmentError({
                        reason: error.kind === "incompatible" ? "incompatible" : "ssh",
                        message: error.message
                      })
                  ),
                  Effect.as(environmentFromRemoteDevice(claimed.device))
                )
            )
          )
      }

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
          const device = yield* Schema.decodeUnknown(RemoteDeviceSchema)(result.device).pipe(
            Effect.mapError(() =>
              environmentError(502, "The device service returned an invalid response.")
            )
          )
          return environmentFromRemoteDevice(device)
        })

      const revoke = (deviceId: string) =>
        request(`${DEVICE_API_ROOT}/${encodeURIComponent(deviceId)}/revoke`, Schema.Unknown, {
          method: "POST"
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
        pairLink,
        pairSsh,
        rename,
        revoke
      } as const
    })
  }
) {}
