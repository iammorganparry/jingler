import type {
  AccountDevice,
  DeviceEnrollmentCredentialResponse,
  PendingDeviceRegistrationResponse,
  RemoteDevice
} from "@jingler/core"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EnvironmentService, environmentFromRemoteDevice } from "./environment.js"
import {
  type ActivateRemoteDeviceInput,
  type BootstrapSshInput,
  type EnrolledOwnedDevice,
  type InstallAndEnrollOwnedDeviceInput,
  type InstallAndBootstrapSshInput,
  RemoteBootstrapService,
  SshBootstrapError
} from "./remote-bootstrap.js"
import { makeInMemorySecretStore, SecretStore, type SecretStoreShape } from "./secret-store.js"

const device: RemoteDevice = {
  version: 1,
  deviceId: "device_buildbox",
  displayName: "buildbox",
  platform: { os: "darwin", arch: "arm64" },
  publicKey: {
    algorithm: "Ed25519",
    encoding: "base64url",
    value: "A".repeat(43)
  },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    maxConcurrentSessions: 2
  },
  agentVersion: "2.0.3",
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

const accountDevice: AccountDevice = {
  version: 1,
  deviceId: device.deviceId,
  accountId: "user-one",
  identityFingerprint: "F".repeat(43),
  displayName: device.displayName,
  platform: device.platform,
  publicKey: device.publicKey,
  capabilities: device.capabilities,
  state: "active",
  generation: device.generation,
  enrolledAt: 100,
  createdAt: 100,
  updatedAt: 200,
  revokedAt: null,
  presence: {
    version: 1,
    deviceId: device.deviceId,
    state: "online",
    connectedAt: 150,
    lastSeenAt: 200,
    activeSessionIds: []
  }
}

const enrollmentCredential: DeviceEnrollmentCredentialResponse = {
  version: 1,
  claim: {
    version: 1,
    claimId: "claim_abcdefghijklmnop",
    subject: "user-one",
    deviceId: device.deviceId,
    clientInstanceId: "client_abcdefghijklmnop",
    audience: "device-claim",
    issuedAt: 100,
    expiresAt: 200
  },
  token: "signed-enrollment-token"
}

const environmentLayer = (bootstrap: {
  readonly bootstrap: (
    input: BootstrapSshInput
  ) => Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError>
  readonly installAndBootstrap: (
    input: InstallAndBootstrapSshInput
  ) => Effect.Effect<PendingDeviceRegistrationResponse, SshBootstrapError>
  readonly activate?: (input: ActivateRemoteDeviceInput) => Effect.Effect<void, SshBootstrapError>
  readonly installAndEnroll?: (
    input: InstallAndEnrollOwnedDeviceInput
  ) => Effect.Effect<EnrolledOwnedDevice, SshBootstrapError>
}, store?: SecretStoreShape) =>
  EnvironmentService.Default.pipe(
    Layer.provide(
      Layer.succeed(RemoteBootstrapService, {
        _tag: "@jingler/RemoteBootstrapService",
        discoverHosts: () => Effect.succeed([]),
        activate: () => Effect.void,
        installAndEnroll: () =>
          Effect.succeed({
            version: 1,
            deviceId: device.deviceId,
            displayName: device.displayName
          }),
        ...bootstrap
      })
    ),
    Layer.provide(
      store
        ? Layer.succeed(SecretStore, store)
        : Layer.effect(SecretStore, makeInMemorySecretStore("desktop-bearer"))
    )
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
      id: "device_buildbox",
      name: "buildbox",
      state: "online",
      agentVersion: "2.0.3",
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
  it("persists the per-install client identity across service restarts", async () => {
    const clientIds: string[] = []
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      clientIds.push(new Headers(init?.headers).get("x-jingler-client-instance-id") ?? "")
      return Response.json({ version: 1, devices: [accountDevice] })
    })
    process.env.JINGLER_AUTH_URL = "https://server.test"
    const store = await Effect.runPromise(makeInMemorySecretStore("desktop-bearer"))
    const bootstrap = {
      bootstrap: () => Effect.succeed(pending),
      installAndBootstrap: () => Effect.succeed(pending)
    }

    await Effect.runPromise(EnvironmentService.list.pipe(Effect.provide(environmentLayer(bootstrap, store))))
    await Effect.runPromise(EnvironmentService.list.pipe(Effect.provide(environmentLayer(bootstrap, store))))

    expect(clientIds).toHaveLength(2)
    expect(clientIds[0]).toMatch(/^client_/u)
    expect(clientIds[1]).toBe(clientIds[0])
  })

  it("uses the server's /api/devices mount for desktop requests", async () => {
    const urls: Array<string> = []
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      urls.push(String(input))
      return Response.json({ version: 1, devices: [accountDevice] })
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

  it("enrolls an owned machine with an invisible account credential", async () => {
    const installCalls: Array<InstallAndEnrollOwnedDeviceInput> = []
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/enrollment-credentials")) {
        return Response.json(enrollmentCredential, { status: 201 })
      }
      expect(url).toBe("https://server.test/api/devices")
      return Response.json({ version: 1, devices: [accountDevice] })
    })
    process.env.JINGLER_AUTH_URL = "https://server.test"
    process.env.JINGLER_DEVICE_AGENT_BUNDLE =
      "/Applications/Jingler.app/Contents/Resources/device-agent/jingler-device.mjs"
    const layer = environmentLayer({
      bootstrap: () => Effect.succeed(pending),
      installAndBootstrap: () => Effect.succeed(pending),
      installAndEnroll: (input) => {
        installCalls.push(input)
        return Effect.succeed({
          version: 1,
          deviceId: device.deviceId,
          displayName: device.displayName
        })
      }
    })

    const environment = await Effect.runPromise(
      EnvironmentService.pairSsh({
        host: "buildbox",
        username: "morgan",
        port: 22
      }).pipe(Effect.provide(layer))
    )

    expect(installCalls).toHaveLength(1)
    expect(installCalls[0]).toMatchObject({
      host: "buildbox",
      username: "morgan",
      port: 22,
      serverUrl: "https://server.test",
      credential: enrollmentCredential,
      agentBundlePath:
        "/Applications/Jingler.app/Contents/Resources/device-agent/jingler-device.mjs"
    })
    expect(environment.id).toBe(device.deviceId)
  })

  it("fails before SSH when the packaged agent is unavailable", async () => {
    const install = vi.fn(() =>
      Effect.succeed({
        version: 1 as const,
        deviceId: device.deviceId,
        displayName: device.displayName
      })
    )
    vi.stubGlobal("fetch", async () => Response.json(enrollmentCredential))
    process.env.JINGLER_AUTH_URL = "https://server.test"
    const layer = environmentLayer({
      bootstrap: () => Effect.succeed(pending),
      installAndBootstrap: () => Effect.succeed(pending),
      installAndEnroll: install
    })

    await expect(
      Effect.runPromise(
        EnvironmentService.pairSsh({ host: "buildbox" }).pipe(Effect.provide(layer))
      )
    ).rejects.toMatchObject({ message: "The device agent bundle is unavailable." })

    expect(install).not.toHaveBeenCalled()
  })
})
