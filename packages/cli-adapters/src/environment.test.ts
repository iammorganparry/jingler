import type { PendingDeviceRegistrationResponse, RemoteDevice } from "@jingler/core"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EnvironmentService, environmentFromRemoteDevice } from "./environment.js"
import {
  type ActivateRemoteDeviceInput,
  type BootstrapSshInput,
  type InstallAndBootstrapSshInput,
  RemoteBootstrapService,
  SshBootstrapError
} from "./remote-bootstrap.js"
import { makeInMemorySecretStore, SecretStore } from "./secret-store.js"

const device: RemoteDevice = {
  version: 1,
  deviceId: "device_clive",
  displayName: "clive.local",
  platform: { os: "darwin", arch: "arm64" },
  publicKey: {
    algorithm: "Ed25519",
    encoding: "base64url",
    value: "A".repeat(43)
  },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    harnesses: ["codex"],
    maxConcurrentSessions: 2
  },
  state: "active",
  generation: 3,
  createdAt: 100,
  updatedAt: 200,
  presence: {
    version: 1,
    state: "online",
    connectedAt: 150,
    lastSeenAt: 200,
    activeSessionIds: []
  }
}

const pending = {
  version: 1,
  pendingDeviceId: "pending_test",
  deviceId: device.deviceId,
  pairingCode: "ABCDEFGH",
  expiresAt: 2_000_000_000
} as const

const environmentLayer = (bootstrap: {
  readonly bootstrap: (
    input: BootstrapSshInput
  ) => Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError>
  readonly installAndBootstrap: (
    input: InstallAndBootstrapSshInput
  ) => Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError>
  readonly activate?: (input: ActivateRemoteDeviceInput) => Effect.Effect<void, SshBootstrapError>
}) =>
  EnvironmentService.Default.pipe(
    Layer.provide(
      Layer.succeed(RemoteBootstrapService, {
        _tag: "@jingler/RemoteBootstrapService",
        discoverHosts: () => Effect.succeed([]),
        activate: () => Effect.void,
        ...bootstrap
      })
    ),
    Layer.provide(Layer.effect(SecretStore, makeInMemorySecretStore("desktop-bearer")))
  )

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.JINGLER_AUTH_URL
  delete process.env.JINGLER_DEVICE_RELAY_URL
  delete process.env.JINGLER_DEVICE_AGENT_BUNDLE
})

describe("environment metadata", () => {
  it("maps registry presence to a renderer-safe environment", () => {
    expect(environmentFromRemoteDevice(device)).toMatchObject({
      id: "device_clive",
      name: "clive.local",
      state: "online",
      lastSeenAt: 200
    })
  })
  it("does not copy grants keys or registry generations into renderer metadata", () => {
    const environment = environmentFromRemoteDevice(device)
    expect(environment).not.toHaveProperty("publicKey")
    expect(environment).not.toHaveProperty("generation")
  })
  it("marks a device without session-start capability as incompatible", () => {
    expect(
      environmentFromRemoteDevice({
        ...device,
        capabilities: {
          ...device.capabilities,
          capabilities: ["session.observe"]
        }
      }).state
    ).toBe("incompatible")
  })
})

describe("environment device API", () => {
  it("uses the server's /api/devices mount for desktop requests", async () => {
    const urls: Array<string> = []
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      urls.push(String(input))
      return Response.json({ version: 1, devices: [device] })
    })
    process.env.JINGLER_AUTH_URL = "https://server.test"
    const layer = environmentLayer({
      bootstrap: () => Effect.succeed(pending),
      installAndBootstrap: () => Effect.succeed(pending)
    })

    const environments = await Effect.runPromise(
      EnvironmentService.list.pipe(Effect.provide(layer))
    )

    expect(urls).toStrictEqual(["https://server.test/api/devices"])
    expect(environments.map((environment) => environment.id)).toStrictEqual([device.deviceId])
  })

  it("installs the packaged agent when the remote binary is missing", async () => {
    const bootstrapCalls: Array<unknown> = []
    const installCalls: Array<unknown> = []
    const activateCalls: Array<unknown> = []
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://server.test/api/devices/pairing/claim")
      return Response.json({ version: 1, subject: "user-one", device })
    })
    process.env.JINGLER_AUTH_URL = "https://server.test"
    process.env.JINGLER_DEVICE_RELAY_URL = "https://relay.test"
    process.env.JINGLER_DEVICE_AGENT_BUNDLE =
      "/Applications/Jingler.app/Contents/Resources/device-agent/jingler-device.mjs"
    const layer = environmentLayer({
      bootstrap: (input) => {
        bootstrapCalls.push(input)
        return Effect.fail(
          new SshBootstrapError({
            kind: "incompatible",
            message: "The remote Jingler device agent is missing or incompatible"
          })
        )
      },
      installAndBootstrap: (input) => {
        installCalls.push(input)
        return Effect.succeed(pending)
      },
      activate: (input) => {
        activateCalls.push(input)
        return Effect.void
      }
    })

    const environment = await Effect.runPromise(
      EnvironmentService.pairSsh({
        host: "clive.local",
        username: "morgan",
        port: 22
      }).pipe(Effect.provide(layer))
    )

    expect(bootstrapCalls).toStrictEqual([
      {
        host: "clive.local",
        username: "morgan",
        port: 22,
        relayUrl: "https://relay.test"
      }
    ])
    expect(installCalls).toStrictEqual([
      {
        host: "clive.local",
        username: "morgan",
        port: 22,
        relayUrl: "https://relay.test",
        agentBundlePath:
          "/Applications/Jingler.app/Contents/Resources/device-agent/jingler-device.mjs"
      }
    ])
    expect(activateCalls).toStrictEqual([
      {
        host: "clive.local",
        username: "morgan",
        port: 22,
        relayUrl: "https://relay.test",
        subject: "user-one",
        deviceId: device.deviceId,
        serverUrl: "https://server.test"
      }
    ])
    expect(environment.id).toBe(device.deviceId)
  })

  it("uses an already-installed compatible agent without uploading", async () => {
    const install = vi.fn(() => Effect.succeed(pending))
    vi.stubGlobal("fetch", async () => Response.json({ version: 1, subject: "user-one", device }))
    process.env.JINGLER_AUTH_URL = "https://server.test"
    process.env.JINGLER_DEVICE_AGENT_BUNDLE = "/bundle/jingler-device.mjs"
    const layer = environmentLayer({
      bootstrap: () => Effect.succeed(pending),
      installAndBootstrap: install
    })

    await Effect.runPromise(
      EnvironmentService.pairSsh({ host: "clive.local" }).pipe(Effect.provide(layer))
    )

    expect(install).not.toHaveBeenCalled()
  })
})
