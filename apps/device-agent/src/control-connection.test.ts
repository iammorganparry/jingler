import type { DeviceRelayGrantResponse, RemoteDeviceDiscovery } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { type ControlConnectionDependencies, type ControlSocket, runControlConnection } from "./control-connection.js"

const discovery: RemoteDeviceDiscovery = {
  version: 1,
  agentVersion: "2.0.3",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start", "session.input", "session.cancel", "session.observe"],
    harnesses: ["codex"],
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
      expect(messages.map((message) => JSON.parse(message).type)).toStrictEqual(["announce", "ping"])
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
