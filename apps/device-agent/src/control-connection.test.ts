import { codexEndpointLogin } from "@jingler/cli-adapters/runtime/codex/login"
import type { DeviceRelayGrantResponse, RemoteDeviceDiscovery } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"
import { type ControlConnectionDependencies, type ControlSocket, runControlConnection } from "./control-connection.js"

const discovery: RemoteDeviceDiscovery = {
  version: 1,
  agentVersion: "2.0.3",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start", "session.input", "session.cancel", "session.observe"],
    maxConcurrentSessions: 4
  },
  repositories: []
}

const grant = (id: number): DeviceRelayGrantResponse => ({
  version: 1,
  relayUrl: "https://relay.example.test",
  grant: `device-grant-${id}`,
  claims: {
    version: 1,
    issuer: "jingler",
    audience: "device-connect",
    subject: "user-1",
    deviceId: "device-1",
    sessionId: null,
    clientInstanceId: null,
    attachmentGeneration: null,
    controllerLeaseGeneration: null,
    deviceGeneration: 1,
    issuedAt: 100,
    expiresAt: 200,
    grantId: `grant-${id}`
  }
})

const socket = (code: number, reason: string, sent: Array<string>): ControlSocket => ({
  send: (message) => sent.push(message),
  close: () => undefined,
  onMessage: () => () => undefined,
  waitForClose: async () => ({ code, reason })
})

describe("device control connection", () => {
  it("accepts a released relay session frame without fencing fields", async () => {
    const controller = new AbortController()
    let deliver: ((message: unknown) => void) | null = null
    const handled: Array<Parameters<NonNullable<ControlConnectionDependencies["handleSessionRequest"]>>[0]> = []
    const running = runControlConnection({
      refreshGrant: async () => grant(1),
      discover: async () => discovery,
      connect: async () => ({
        send: () => undefined,
        close: () => undefined,
        onMessage: (handler) => {
          deliver = handler
          return () => undefined
        },
        waitForClose: (signal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ code: 1000, reason: "stopped" }), { once: true })
        })
      }),
      sleep: async () => undefined,
      handleSessionRequest: async (request) => { handled.push(request) }
    }, controller.signal)

    await vi.waitFor(() => expect(deliver).not.toBeNull())
    deliver!({
      type: "session-request",
      sessionId: "session_legacy_abcdefgh",
      grant: "legacy-session-grant"
    })
    await vi.waitFor(() => expect(handled).toHaveLength(1))
    expect(handled[0]).toMatchObject({
      clientInstanceId: expect.stringMatching(/^legacy_/u),
      attachmentGeneration: 1,
      controllerLeaseGeneration: 1
    })
    controller.abort()
    await expect(running).resolves.toBe("stopped")
  })

  it.each(["refresh", "auth-status", "login-start", "login-cancel"])("answers a correlated endpoint catalog %s for its own target", async (action) => {
    const controller = new AbortController()
    let deliver: ((message: unknown) => void) | null = null
    const sent: string[] = []
    const code = { loginId: "login", verificationUrl: "https://example.com", userCode: "TEST" }
    const start = vi.spyOn(codexEndpointLogin, "start").mockResolvedValue(code)
    const cancel = vi.spyOn(codexEndpointLogin, "cancel").mockResolvedValue(undefined)
    const endpointDiscovery: RemoteDeviceDiscovery = {
      ...discovery,
      capabilities: {
        ...discovery.capabilities,
        runtime: {
          versions: {
            behavior: "1", authentication: "1", prompt: "1", tools: "1",
            diff: "1", policy: "1", capabilities: "1", piSdk: "1"
          },
          toolIds: [],
          resourceIds: [],
          targetId: "device-1"
        },
        endpointCatalog: {
          endpoints: [],
          refreshedAt: "2026-09-25T00:00:00.000Z",
          stale: false
        }
      }
    }
    const running = runControlConnection({
      refreshGrant: async () => grant(1),
      discover: async () => endpointDiscovery,
      connect: async () => ({
        send: (message) => sent.push(message),
        close: () => undefined,
        onMessage: (handler) => {
          deliver = handler
          return () => undefined
        },
        waitForClose: (signal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ code: 1000, reason: "stopped" }), { once: true })
        })
      }),
      sleep: async () => undefined
    }, controller.signal)

    await vi.waitFor(() => expect(deliver).not.toBeNull())
    deliver!({ type: "endpoint-catalog-request", version: 1, requestId: "wrong-target", targetId: "other-device", action })
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    deliver!({
      type: "endpoint-catalog-request",
      version: 1,
      requestId: "request-1",
      targetId: "device-1",
      endpointId: "device-1:codex:default", loginId: "login",
      action
    })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(JSON.parse(sent[1]!)).toMatchObject({
      type: "endpoint-catalog-update",
      requestId: "request-1",
      targetId: "device-1",
      catalog: endpointDiscovery.capabilities.endpointCatalog
    })
    if (action === "login-start") {
      expect(start).toHaveBeenCalledWith("device-1:codex:default", "device-1")
      expect(JSON.parse(sent[1]!).login).toEqual(code)
    }
    if (action === "login-cancel") expect(cancel).toHaveBeenCalledWith("device-1:codex:default", "device-1", "login")
    start.mockRestore()
    cancel.mockRestore()
    controller.abort()
    await expect(running).resolves.toBe("stopped")
  })

  it("refreshes the device grant before reconnect", async () => {
    const controller = new AbortController()
    let refreshes = 0
    let connections = 0
    const dependencies: ControlConnectionDependencies = {
      refreshGrant: async () => grant(++refreshes),
      discover: async () => discovery,
      connect: async () => {
        connections += 1
        return socket(4001, "Device grant expired", [])
      },
      sleep: async () => {
        if (connections === 2) controller.abort()
      }
    }
    await runControlConnection(dependencies, controller.signal)
    expect(refreshes).toBe(2)
    expect(connections).toBe(2)
  })

  it("reannounces presence and capabilities after reconnect", async () => {
    const controller = new AbortController()
    const sent: Array<Array<string>> = []
    let connections = 0
    const dependencies: ControlConnectionDependencies = {
      refreshGrant: async () => grant(connections + 1),
      discover: async () => discovery,
      connect: async () => {
        connections += 1
        const messages: Array<string> = []
        sent.push(messages)
        return socket(4001, "expired", messages)
      },
      sleep: async () => {
        if (connections === 2) controller.abort()
      }
    }
    await runControlConnection(dependencies, controller.signal)
    expect(sent).toHaveLength(2)
    for (const messages of sent) {
      expect(messages.map((message) => JSON.parse(message).type)).toStrictEqual(["announce"])
      expect(JSON.parse(messages[0] ?? "{}").discovery).toStrictEqual(discovery)
    }
  })

  it("stops reconnecting after device revocation", async () => {
    let refreshes = 0
    let sleeps = 0
    const result = await runControlConnection(
      {
        refreshGrant: async () => grant(++refreshes),
        discover: async () => discovery,
        connect: async () => socket(4003, "Device revoked", []),
        sleep: async () => {
          sleeps += 1
        }
      },
      new AbortController().signal
    )
    expect(result).toBe("revoked")
    expect(refreshes).toBe(1)
    expect(sleeps).toBe(0)
  })

  it("aborts an in-flight grant refresh when the daemon stops", async () => {
    const controller = new AbortController()
    let receivedAbort = false
    const running = runControlConnection(
      {
        refreshGrant: (signal) => {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                receivedAbort = true
                reject(new Error("aborted"))
              },
              { once: true }
            )
          })
        },
        discover: async () => discovery,
        connect: async () => socket(1000, "stopped", []),
        sleep: async () => undefined
      },
      controller.signal
    )
    await Promise.resolve()
    controller.abort()
    await expect(running).resolves.toBe("stopped")
    expect(receivedAbort).toBe(true)
  })
})

describe("control reconnect backoff", () => {
  it("increments refresh failures and resets backoff only after announcing a connection", async () => {
    const controller = new AbortController()
    let refreshes = 0
    const sleeps: number[] = []
    const sent: string[] = []
    await runControlConnection({
      refreshGrant: async () => {
        refreshes += 1
        if (refreshes < 3) throw new Error("Temporarily offline")
        return grant(refreshes)
      },
      discover: async () => discovery,
      connect: async () => socket(1000, "retry", sent),
      sleep: async (duration) => {
        sleeps.push(duration)
        if (sleeps.length === 3) controller.abort()
      }
    }, controller.signal)
    expect(sleeps).toEqual([1_000, 2_000, 500])
    expect(sent.map((message) => JSON.parse(message).type)).toEqual(["announce"])
  })
})
