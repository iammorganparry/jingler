import { codexEndpointLogin } from "@jingler/cli-adapters/runtime/codex/login"
import { EndpointCatalogRequest } from "@jingler/core"
import type { DeviceChallenge, DeviceRelayGrantResponse, RemoteDeviceDiscovery } from "@jingler/core"
import {
  DeviceChallenge as DeviceChallengeSchema,
  DeviceRelayGrantResponse as DeviceRelayGrantResponseSchema
} from "@jingler/core"
import { Data, Schema } from "effect"
import { createHash } from "node:crypto"
import WebSocket from "ws"
import type { DeviceEnrollment } from "./device-client.js"
import type { DeviceIdentity } from "./device-identity.js"

export type { DeviceEnrollment } from "./device-client.js"

export class DeviceControlError extends Data.TaggedError("DeviceControlError")<{
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

const clientInstanceIdPattern = /^[A-Za-z0-9_-]{1,128}$/u

const legacyClientInstanceId = (sessionId: string): string =>
  `legacy_${createHash("sha256").update(sessionId, "utf8").digest("base64url").slice(0, 32)}`

export interface ControlSocket {
  readonly send: (message: string) => void
  readonly waitForClose: (signal: AbortSignal) => Promise<{ readonly code: number; readonly reason: string }>
  readonly close: () => void
  readonly onMessage: (handler: (message: unknown) => void) => () => void
}

export interface ControlConnectionDependencies {
  readonly refreshGrant: (signal: AbortSignal) => Promise<DeviceRelayGrantResponse>
  readonly connect: (url: string, grant: string, signal: AbortSignal) => Promise<ControlSocket>
  readonly discover: () => Promise<RemoteDeviceDiscovery>
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly handleSessionRequest?: (request: {
    readonly relayUrl: string
    readonly sessionId: string
    readonly grant: string
    readonly keyOffer: unknown
    readonly clientInstanceId: string
    readonly attachmentGeneration: number
    readonly controllerLeaseGeneration: number
  }) => Promise<void>
}

const requestJson = async <A, I>(url: string, init: RequestInit, schema: Schema.Schema<A, I>): Promise<A> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new DeviceControlError({
      message: response.status === 403 ? "Device revoked" : `Device API returned ${response.status}`,
      status: response.status
    })
  }
  try {
    return Schema.decodeUnknownSync(schema)(await response.json(), {
      onExcessProperty: "error"
    })
  } catch (cause) {
    throw new DeviceControlError({
      message: "Invalid device API response",
      cause
    })
  }
}

const apiUrl = (serverUrl: string, path: string): string => `${serverUrl.replace(/\/$/u, "")}/api/devices${path}`

export const createDeviceGrantRefresher =
  (
    enrollment: DeviceEnrollment,
    identity: DeviceIdentity
  ): ((signal: AbortSignal) => Promise<DeviceRelayGrantResponse>) =>
  async (signal) => {
    const challenge = await requestJson(
      apiUrl(enrollment.serverUrl, "/challenges"),
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          version: 1,
          subject: enrollment.subject,
          deviceId: enrollment.deviceId
        })
      },
      DeviceChallengeSchema
    )
    return requestJson(
      apiUrl(enrollment.serverUrl, "/challenges/exchange"),
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          version: 1,
          challenge: challenge satisfies DeviceChallenge,
          signature: identity.signChallenge(challenge)
        })
      },
      DeviceRelayGrantResponseSchema
    )
  }

const websocketUrl = (relayUrl: string): string => {
  const url = new URL("/v1/device-connect", relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export const connectDeviceWebSocket = (relayUrl: string, grant: string, signal: AbortSignal): Promise<ControlSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl(relayUrl), {
      headers: { authorization: `Bearer ${grant}` }
    })
    let settled = false
    const cleanupAdmission = () => {
      socket.off("error", fail)
      signal.removeEventListener("abort", abort)
    }
    const fail = (cause: Error) => {
      if (settled) return
      settled = true
      cleanupAdmission()
      socket.terminate()
      reject(
        new DeviceControlError({
          message: "Device relay connection failed",
          cause
        })
      )
    }
    const abort = () => {
      if (settled) return
      settled = true
      cleanupAdmission()
      socket.terminate()
      reject(new DeviceControlError({ message: "Device relay connection stopped" }))
    }
    if (signal.aborted) {
      abort()
      return
    }
    socket.once("error", fail)
    signal.addEventListener("abort", abort, { once: true })
    socket.once("open", () => {
      if (settled) return
      settled = true
      cleanupAdmission()
      resolve({
        send: (message) => socket.send(message),
        close: () => socket.close(),
        onMessage: (handler) => {
          const listener = (data: WebSocket.RawData) => {
            try {
              handler(JSON.parse(data.toString("utf8")))
            } catch {
              /* ignore malformed relay messages */
            }
          }
          socket.on("message", listener)
          return () => socket.off("message", listener)
        },
        waitForClose: (signal) =>
          new Promise((resolveClose) => {
            const abort = () => {
              socket.close(1000, "Device agent stopped")
            }
            signal.addEventListener("abort", abort, { once: true })
            socket.once("close", (code, reason) => {
              signal.removeEventListener("abort", abort)
              resolveClose({ code, reason: reason.toString("utf8") })
            })
          })
      })
    })
  })

export const abortableSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })

const isEndpointRequest = (request: Record<string, unknown>, targetId: string | undefined): boolean =>
  Schema.is(EndpointCatalogRequest)(request) && request.targetId === targetId

const handleEndpointLogin = async (input: EndpointCatalogRequest) => {
  try {
    if (input.action === "login-start") return { login: await codexEndpointLogin.start(input.endpointId ?? "", input.targetId) }
    if (input.action === "login-cancel") await codexEndpointLogin.cancel(input.endpointId ?? "", input.targetId, input.loginId ?? "")
    return { login: undefined }
  } catch { return { loginError: "Native Codex login failed on this target", login: undefined } }
}

export type ControlConnectionResult = "stopped" | "revoked"

export const runControlConnection = async (
  dependencies: ControlConnectionDependencies,
  signal: AbortSignal
): Promise<ControlConnectionResult> => {
  let failures = 0
  while (!signal.aborted) {
    let socket: ControlSocket | null = null
    try {
      // Never reuse a relay grant: every admission, including reconnect, proves
      // possession again and receives a fresh, short-lived device-only grant.
      const refreshed = await dependencies.refreshGrant(signal)
      if (signal.aborted) break
      const discovery = await dependencies.discover()
      if (signal.aborted) break
      socket = await dependencies.connect(refreshed.relayUrl, refreshed.grant, signal)
      const stopMessages = socket.onMessage((message) => {
        if (!message || typeof message !== "object") return
        const request = message as Record<string, unknown>
        if (isEndpointRequest(request, discovery.capabilities.runtime?.targetId)) {
          void (async () => {
            const input = Schema.decodeUnknownSync(EndpointCatalogRequest)(request)
            const { login, loginError } = await handleEndpointLogin(input)
            const updated = await dependencies.discover()
            return { updated, login, loginError }
          })().then(({ updated, login, loginError }) => {
            const catalog = updated.capabilities.endpointCatalog
            if (signal.aborted || catalog === undefined ||
                updated.capabilities.runtime?.targetId !== request.targetId ||
                catalog.endpoints.some(({ endpoint }) => endpoint.targetId !== request.targetId)) return
            socket?.send(JSON.stringify({
              type: "endpoint-catalog-update",
              version: 1,
              requestId: request.requestId,
              targetId: request.targetId,
              catalog, login, loginError
            }))
          }).catch(() => undefined)
          return
        }
        if (!dependencies.handleSessionRequest) return
        if (
          request.type !== "session-request" ||
          typeof request.sessionId !== "string" ||
          typeof request.grant !== "string"
        )
          return
        const { clientInstanceId, attachmentGeneration, controllerLeaseGeneration } = sessionRequestScope(request.sessionId)
        void dependencies
          .handleSessionRequest({
            relayUrl: refreshed.relayUrl,
            sessionId: request.sessionId,
            grant: request.grant,
            keyOffer: request.keyOffer,
            clientInstanceId,
            attachmentGeneration,
            controllerLeaseGeneration
          })
          .catch(() => {
            // The control socket remains healthy; a failed session tunnel is
            // independently retried by the desktop with a fresh scoped grant.
          })

        function sessionRequestScope(sessionId: string) {
          const clientInstanceId = typeof request.clientInstanceId === "string" &&
            clientInstanceIdPattern.test(request.clientInstanceId)
            ? request.clientInstanceId
            : legacyClientInstanceId(sessionId)
          const attachmentGeneration = Number.isSafeInteger(request.attachmentGeneration) &&
            (request.attachmentGeneration as number) >= 1
            ? request.attachmentGeneration as number
            : 1
          const controllerLeaseGeneration = Number.isSafeInteger(request.controllerLeaseGeneration) &&
            (request.controllerLeaseGeneration as number) >= 1
            ? request.controllerLeaseGeneration as number
            : 1
          return { clientInstanceId, attachmentGeneration, controllerLeaseGeneration }
        }
      })
      socket.send(JSON.stringify({ type: "announce", discovery }))
      failures = 0
      const closed = await socket.waitForClose(signal)
      stopMessages()
      if (isRevokedSocketClose(closed)) return "revoked"
    } catch (error) {
      if (isRevokedControlError(error)) {
        return "revoked"
      }
      failures = failuresAfterError(failures, signal)
    } finally {
      socket?.close()
    }
    await sleepBeforeReconnect()
  }
  return "stopped"

  function isRevokedSocketClose(closed: { readonly code: number; readonly reason: string }) {
    return closed.code === 4003 || /revoked/iu.test(closed.reason)
  }

  async function sleepBeforeReconnect() {
    if (!signal.aborted) {
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(failures, 6))
      await dependencies.sleep(backoff, signal)
    }
  }

  function isRevokedControlError(error: unknown) {
    return error instanceof DeviceControlError && (error.status === 403 || /revoked/iu.test(error.message))
  }
}

const failuresAfterError = (failures: number, signal: AbortSignal): number =>
  signal.aborted ? failures : failures + 1
