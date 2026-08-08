import type { DeviceChallenge, DeviceRelayGrantResponse, RemoteDeviceDiscovery } from "@jingler/core"
import {
  DeviceChallenge as DeviceChallengeSchema,
  DeviceRelayGrantResponse as DeviceRelayGrantResponseSchema
} from "@jingler/core"
import { Data, Schema } from "effect"
import WebSocket from "ws"
import type { DeviceIdentity } from "./device-identity.js"

export class DeviceControlError extends Data.TaggedError("DeviceControlError")<{
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export interface DeviceEnrollment {
  readonly subject: string
  readonly deviceId: string
  readonly serverUrl: string
}

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
        if (!dependencies.handleSessionRequest || !message || typeof message !== "object") return
        const request = message as Record<string, unknown>
        if (
          request.type !== "session-request" ||
          typeof request.sessionId !== "string" ||
          typeof request.grant !== "string"
        )
          return
        void dependencies
          .handleSessionRequest({
            relayUrl: refreshed.relayUrl,
            sessionId: request.sessionId,
            grant: request.grant,
            keyOffer: request.keyOffer
          })
          .catch(() => {
            // The control socket remains healthy; a failed session tunnel is
            // independently retried by the desktop with a fresh scoped grant.
          })
      })
      socket.send(JSON.stringify({ type: "announce", discovery }))
      socket.send(JSON.stringify({ type: "ping" }))
      failures = 0
      const closed = await socket.waitForClose(signal)
      stopMessages()
      if (closed.code === 4003 || /revoked/iu.test(closed.reason)) return "revoked"
    } catch (error) {
      if (error instanceof DeviceControlError && (error.status === 403 || /revoked/iu.test(error.message))) {
        return "revoked"
      }
      if (!signal.aborted) failures += 1
    } finally {
      socket?.close()
    }
    if (!signal.aborted) {
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(failures, 6))
      await dependencies.sleep(backoff, signal)
    }
  }
  return "stopped"
}
