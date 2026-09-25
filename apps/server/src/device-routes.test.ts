import type { DeviceRecord, DeviceRelayGrantResponse } from "@jingler/core"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import {
  issueDeviceClaim,
  issueDeviceGrant,
  verifyDeviceClaim,
  verifyDeviceGrant
} from "./device-grant.js"
import {
  createDeviceRoutes,
  type DeviceStore,
  type DeviceRoutesDependencies
} from "./device-routes.js"
import { loadEnv } from "./env.js"

const signingSecret = "device-relay-secret-at-least-32-bytes"
const relayUrl = "https://device-relay.test"
const publicKey = {
  algorithm: "Ed25519",
  encoding: "base64url",
  value: "A".repeat(43)
} as const

const device = {
  version: 1,
  deviceId: "device_abcdefghijklmnop",
  displayName: "Build host",
  platform: { os: "linux", arch: "x64" },
  publicKey,
  capabilities: {
    version: 1,
    capabilities: ["session.start", "session.observe"],
    maxConcurrentSessions: 2
  },
  state: "active",
  generation: 7,
  createdAt: 100,
  updatedAt: 120,
  presence: {
    version: 1,
    state: "offline",
    connectedAt: null,
    lastSeenAt: null,
    activeSessionIds: []
  }
} as const

const deviceRecord = {
  version: 1,
  deviceId: device.deviceId,
  accountId: "user-one",
  identityFingerprint: "A".repeat(43),
  displayName: device.displayName,
  platform: device.platform,
  publicKey: device.publicKey,
  capabilities: device.capabilities,
  state: device.state,
  generation: device.generation,
  enrolledAt: device.createdAt,
  createdAt: device.createdAt,
  updatedAt: device.updatedAt,
  revokedAt: null
} as const

interface RelayCall {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
  readonly body: string | null
}

const harness = (
  relayHandler: (url: URL, init: RequestInit) => Promise<Response> = async (
    url
  ) => {
    if (url.pathname === "/v1/devices") {
      return Response.json({ version: 1, devices: [device] })
    }
    if (url.pathname === "/v1/device-challenges/exchange") {
      return Response.json({
        status: "verified",
        subject: "user-one",
        deviceId: device.deviceId,
        generation: device.generation
      })
    }
    if (url.pathname.includes("/sessions/")) {
      return Response.json({
        version: 1,
        deviceId: device.deviceId,
        generatedAt: 100,
        sessions: []
      })
    }
    return Response.json({ accepted: true })
  },
  preserveCanonicalDeviceId = false
) => {
  const calls: RelayCall[] = []
  let storedDevice: DeviceRecord = deviceRecord
  const enrollments = new Map<string, Parameters<DeviceStore["createEnrollment"]>[0]>()
  const consumedEnrollments = new Map<string, { fingerprint: string; device: DeviceRecord }>()
  const store: DeviceStore = {
    createEnrollment: async (credential) => { enrollments.set(credential.claimId, credential) },
    consumeAndUpsert: async ({ credential, identityFingerprint, registration }) => {
      if (!enrollments.delete(credential.claimId)) {
        const consumed = consumedEnrollments.get(credential.claimId)
        return consumed?.fingerprint === identityFingerprint
          ? { status: "registered", device: consumed.device }
          : { status: "replayed" }
      }
      storedDevice = {
        ...storedDevice,
        deviceId: preserveCanonicalDeviceId ? storedDevice.deviceId : credential.deviceId,
        accountId: credential.subject,
        identityFingerprint,
        displayName: registration.displayName,
        platform: registration.platform,
        publicKey: registration.publicKey,
        capabilities: registration.capabilities
      }
      consumedEnrollments.set(credential.claimId, {
        fingerprint: identityFingerprint,
        device: storedDevice
      })
      return { status: "registered", device: storedDevice }
    },
    listForUser: async (userId) => userId === storedDevice.accountId ? [storedDevice] : [],
    findForUser: async (userId, deviceId) =>
      userId === storedDevice.accountId && deviceId === storedDevice.deviceId
        ? storedDevice
        : null,
    renameForUser: async ({ userId, deviceId, displayName }) => {
      if (userId !== storedDevice.accountId || deviceId !== storedDevice.deviceId) return null
      storedDevice = { ...storedDevice, displayName }
      return storedDevice
    },
    revokeForUser: async ({ userId, deviceId }) => {
      if (userId !== storedDevice.accountId || deviceId !== storedDevice.deviceId) return null
      storedDevice = { ...storedDevice, state: "revoked", revokedAt: 100, generation: 8 }
      return storedDevice
    }
  }
  let grantSequence = 0
  const dependencies: DeviceRoutesDependencies = {
    enabled: true,
    configured: true,
    relayUrl,
    bootstrapTtlSeconds: 300,
    nowSeconds: () => 100,
    getUserId: async (headers) =>
      headers.get("authorization") === "Bearer better-auth-desktop-bearer"
        ? "user-one"
        : null,
    issueGrant: (input): DeviceRelayGrantResponse => {
      grantSequence += 1
      return issueDeviceGrant(
        input,
        { relayUrl, signingSecret, ttlSeconds: 300 },
        100,
        `grant-${grantSequence}`
      )
    },
    issueClaim: (input) =>
      issueDeviceClaim(
        input,
        { signingSecret, ttlSeconds: 300 },
        100,
        "claim_abcdefghijklmnop"
      ),
    verifyClaim: (token, nowSeconds) =>
      verifyDeviceClaim(token, signingSecret, nowSeconds),
    relayFetch: async (input, init) => {
      const headers = new Headers(init.headers)
      calls.push({
        url: input,
        method: init.method ?? "GET",
        authorization: headers.get("authorization"),
        body: typeof init.body === "string" ? init.body : null
      })
      return relayHandler(new URL(input), init)
    },
    deviceStore: store
  }
  const app = new Hono().route(
    "/api/devices",
    createDeviceRoutes(() => dependencies)
  )
  return { app, calls, dependencies }
}

const authenticated = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://server.test${path}`, {
    ...init,
    headers: {
      authorization: "Bearer better-auth-desktop-bearer",
      "content-type": "application/json",
      "x-jingler-client-instance-id": "client_abcdefghijklmnop",
      ...Object.fromEntries(new Headers(init.headers).entries())
    }
  })

const relayGrant = (call: RelayCall): string => {
  expect(call.authorization).toMatch(/^Bearer /)
  return call.authorization!.slice("Bearer ".length)
}

describe("device server routes", () => {
  it("publishes validated secret-free bootstrap configuration", async () => {
    const value = harness()
    const response = await value.app.request("/api/devices/bootstrap")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    const body = await response.json()
    expect(body).toEqual({
      version: 1,
      enabled: true,
      relayOrigin: relayUrl,
      protocols: ["jingler-device-v1", "jingler-session-v1"],
      issuedAt: 100,
      expiresAt: 400,
      cacheMaxAgeSeconds: 300
    })
    expect(JSON.stringify(body)).not.toContain(signingSecret)
    expect(value.calls).toHaveLength(0)
  })

  it("mints an account- and client-bound one-time claim for SSH delivery", async () => {
    const value = harness()
    const response = await value.app.fetch(
      authenticated("/api/devices/claims", {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          deviceId: "device_ssh_abcdefghijkl",
          clientInstanceId: "client_desktop_abcdefgh"
        })
      })
    )
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body).toMatchObject({
      version: 1,
      claim: {
        subject: "user-one",
        deviceId: "device_ssh_abcdefghijkl",
        clientInstanceId: "client_desktop_abcdefgh",
        audience: "device-claim"
      }
    })
    expect(
      verifyDeviceClaim(body.token, signingSecret, 200)
    ).toMatchObject(body.claim)
    expect(JSON.stringify(body)).not.toContain("better-auth-desktop-bearer")
    expect(value.calls).toHaveLength(0)
  })

  it("idempotently returns the same device after an enrollment response is lost", async () => {
    const value = harness()
    const issuedResponse = await value.app.fetch(
      authenticated("/api/devices/enrollment-credentials", {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          deviceId: "device_enrolled_abcdefghijkl",
          clientInstanceId: "client_abcdefghijklmnop"
        })
      })
    )
    const issued = await issuedResponse.json()
    const exchange = () =>
      value.app.request("/api/devices/enrollments/exchange", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          version: 1,
          credentialId: issued.claim.claimId,
          registration: {
            version: 1,
            displayName: "Owned machine",
            platform: { os: "linux", arch: "x64" },
            publicKey,
            capabilities: device.capabilities
          }
        })
      })
    const first = await exchange()
    expect(first.status).toBe(201)
    await expect(first.json()).resolves.toMatchObject({
      device: {
        accountId: "user-one",
        deviceId: "device_enrolled_abcdefghijkl",
        displayName: "Owned machine"
      }
    })
    const replay = await exchange()
    expect(replay.status).toBe(201)
    await expect(replay.json()).resolves.toMatchObject({
      device: { deviceId: "device_enrolled_abcdefghijkl" }
    })
  })

  it("re-enrolls a known identity under its canonical device id in both stores", async () => {
    const value = harness(undefined, true)
    const issuedResponse = await value.app.fetch(
      authenticated("/api/devices/enrollment-credentials", {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          deviceId: "device_fresh_abcdefghijkl",
          clientInstanceId: "client_abcdefghijklmnop"
        })
      })
    )
    const issued = await issuedResponse.json()
    const response = await value.app.request("/api/devices/enrollments/exchange", {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        version: 1,
        credentialId: issued.claim.claimId,
        registration: {
          version: 1,
          displayName: "Known machine",
          platform: { os: "linux", arch: "x64" },
          publicKey,
          capabilities: device.capabilities
        }
      })
    })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      device: { deviceId: device.deviceId }
    })
    const relay = value.calls.at(-1)!
    const body = JSON.parse(relay.body!)
    expect(body.claim.deviceId).toBe(device.deviceId)
    expect(verifyDeviceClaim(relayGrant(relay), signingSecret, 200)).toMatchObject({
      deviceId: device.deviceId,
      subject: "user-one"
    })
  })

  it("returns typed disabled and invalid bootstrap configuration failures", async () => {
    const value = harness()
    const disabled = new Hono().route(
      "/api/devices",
      createDeviceRoutes(() => ({ ...value.dependencies, enabled: false }))
    )
    const disabledResponse = await disabled.request("/api/devices/bootstrap")
    expect(disabledResponse.status).toBe(200)
    await expect(disabledResponse.json()).resolves.toMatchObject({ enabled: false })

    const invalid = new Hono().route(
      "/api/devices",
      createDeviceRoutes(() => ({
        ...value.dependencies,
        configured: false
      }))
    )
    const invalidResponse = await invalid.request("/api/devices/bootstrap")
    expect(invalidResponse.status).toBe(503)
    await expect(invalidResponse.json()).resolves.toMatchObject({
      _tag: "DeviceControlPlaneError",
      reason: "invalid-configuration",
      retryable: false
    })
  })

  it("proxies scoped discovery without forwarding the BetterAuth bearer", async () => {
    const discovery = { version: 1, deviceId: device.deviceId, updatedAt: 150, discovery: { version: 1, agentVersion: "2.0.3", platform: device.platform, capabilities: device.capabilities, repositories: [] } }
    const value = harness(async (url) => url.pathname.endsWith("/discovery") ? Response.json(discovery) : Response.json({ version: 1, devices: [device] }))
    const response = await value.app.fetch(authenticated(`/api/devices/${device.deviceId}/discovery`))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(discovery)
    expect(value.calls).toHaveLength(1)
    expect(value.calls[0]!.authorization).not.toContain("better-auth-desktop-bearer")
    expect(verifyDeviceGrant(relayGrant(value.calls[0]!), signingSecret, "device-control", 100)).toMatchObject({
      subject: "user-one",
      deviceId: device.deviceId
    })
  })
  it.each(["refresh", "auth-status"])("proxies target-scoped %s and returns updated discovery", async (action) => {
    const discovery = { version: 1, deviceId: device.deviceId, updatedAt: 200, discovery: { version: 1, agentVersion: "2.0.3", platform: device.platform, capabilities: { ...device.capabilities, runtime: {
      targetId: "remote-target", toolIds: [], resourceIds: [],
      versions: { behavior: "1", authentication: "1", prompt: "1", tools: "1", diff: "1", policy: "1", capabilities: "1", piSdk: "1" }
    } }, repositories: [] } }
    const value = harness(async () => Response.json(discovery))
    const body = { targetId: "remote-target", action }
    const response = await value.app.fetch(authenticated(`/api/devices/${device.deviceId}/discovery`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(discovery)
    expect(value.calls[0]?.method).toBe("POST")
    expect(JSON.parse(value.calls[0]!.body!)).toEqual(body)
    expect(verifyDeviceGrant(relayGrant(value.calls[0]!), signingSecret, "device-control", 100)).toMatchObject({ subject: "user-one", deviceId: device.deviceId })
  })

  it("rejects discovery returned for another device", async () => {
    const value = harness(async () => Response.json({
      version: 1, deviceId: "device_wrong_abcdefgh", updatedAt: null, discovery: null
    }))
    const response = await value.app.fetch(authenticated(`/api/devices/${device.deviceId}/discovery`))
    expect(response.status).toBe(502)
  })

  it("rejects malformed refresh without contacting the relay", async () => {
    const value = harness()
    const response = await value.app.fetch(authenticated(`/api/devices/${device.deviceId}/discovery`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" })
    }))
    expect(response.status).toBe(400)
    expect(value.calls).toHaveLength(0)
  })

  it("keeps the relay off by default and rejects unsafe grant configuration", () => {
    expect(loadEnv({ NODE_ENV: "test" })).toMatchObject({
      deviceRelayEnabled: false,
      deviceRelayConfigured: false,
      deviceRelayGrantTtlSeconds: 300
    })
    expect(() =>
      loadEnv({ NODE_ENV: "test", DEVICE_RELAY_GRANT_TTL_SECONDS: "901" })
    ).toThrow("must be an integer no greater than 900")
    expect(() =>
      loadEnv({ NODE_ENV: "test", DEVICE_RELAY_GRANT_TTL_SECONDS: "1.5" })
    ).toThrow("must be an integer")
    expect(() =>
      loadEnv({
        NODE_ENV: "test",
        DEVICE_RELAY_ENABLED: "true",
        DEVICE_RELAY_URL: relayUrl,
        DEVICE_RELAY_SIGNING_SECRET: "shared-secret",
        BETTER_AUTH_SECRET: "shared-secret"
      })
    ).toThrow("must be distinct")
  })

  it("requires BetterAuth for desktop control endpoints", async () => {
    const value = harness()
    const list = await value.app.request("/api/devices")
    expect(list.status).toBe(401)
    const claim = await value.app.request("/api/devices/pairing/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        pendingDeviceId: "pending_abcdefghijklmnop",
        pairingCode: "ABCDEFGH"
      })
    })
    expect(claim.status).toBe(401)
    expect(value.calls).toHaveLength(0)
  })

  it("derives the pairing owner from the BetterAuth session", async () => {
    const value = harness()
    const response = await value.app.fetch(
      authenticated("/api/devices/pairing/claim", {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          pendingDeviceId: "pending_abcdefghijklmnop",
          pairingCode: "ABCDEFGH"
        })
      })
    )
    expect(response.status).toBe(200)
    expect(value.calls).toHaveLength(1)
    expect(value.calls[0]?.authorization).not.toContain(
      "better-auth-desktop-bearer"
    )
    const claims = verifyDeviceGrant(
      relayGrant(value.calls[0]!),
      signingSecret,
      "device-control",
      200
    )
    expect(claims).toMatchObject({ subject: "user-one", sessionId: null })
    expect(value.calls[0]?.body).toContain("pending_abcdefghijklmnop")
    expect(JSON.stringify(await response.json())).not.toContain(
      "better-auth-desktop-bearer"
    )
  })

  it("lists and revokes only through short-lived user control grants", async () => {
    const value = harness()
    const listed = await value.app.fetch(authenticated("/api/devices"))
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      devices: [{ deviceId: device.deviceId }]
    })
    const revoked = await value.app.fetch(
      authenticated(`/api/devices/${device.deviceId}/revoke`, {
        method: "POST"
      })
    )
    expect(revoked.status).toBe(200)
    expect(value.calls).toHaveLength(2)
    for (const call of value.calls) {
      const claims = verifyDeviceGrant(
        relayGrant(call),
        signingSecret,
        "device-control",
        200
      )
      expect(claims.subject).toBe("user-one")
      expect(call.authorization).not.toContain("better-auth-desktop-bearer")
    }
    expect(value.calls[1]?.url).toContain(
      `/v1/devices/${device.deviceId}/revoke`
    )
  })

  it("forwards an authenticated rename through a device-scoped control grant", async () => {
    const value = harness()
    const response = await value.app.fetch(
      authenticated(`/api/devices/${device.deviceId}/rename`, {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          deviceId: device.deviceId,
          displayName: "Build machine"
        })
      })
    )
    expect(response.status).toBe(200)
    expect(value.calls).toHaveLength(1)
    expect(value.calls[0]?.url).toBe(
      `${relayUrl}/v1/devices/${device.deviceId}/rename`
    )
    expect(value.calls[0]?.body).toContain("Build machine")
    expect(
      verifyDeviceGrant(
        relayGrant(value.calls[0]!),
        signingSecret,
        "device-control",
        200
      )
    ).toMatchObject({
      subject: "user-one",
      deviceId: device.deviceId
    })
  })

  it("looks up authoritative device and lease generations before issuing a session tunnel grant", async () => {
    const value = harness(async (url) =>
      url.pathname.includes("/sessions/")
        ? Response.json({
            version: 1,
            deviceId: device.deviceId,
            generatedAt: 100,
            sessions: [{
              version: 1,
              sessionId: "session_abcdefghijklmnop",
              state: "idle",
              controllerClientInstanceId: null,
              controllerLeaseGeneration: 9,
              updatedAt: 100
            }]
          })
        : Response.json({ accepted: true })
    )
    const response = await value.app.fetch(
      authenticated("/api/devices/grants", {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          audience: "session-tunnel",
          deviceId: device.deviceId,
          sessionId: "session_abcdefghijklmnop",
          clientInstanceId: "client_abcdefghijklmnop",
          attachmentGeneration: 2,
          controllerLeaseGeneration: 3
        })
      })
    )
    expect(response.status).toBe(200)
    const body: DeviceRelayGrantResponse = await response.json()
    expect(
      verifyDeviceGrant(body.grant, signingSecret, "session-tunnel", 200)
    ).toMatchObject({
      subject: "user-one",
      deviceId: device.deviceId,
      sessionId: "session_abcdefghijklmnop",
      clientInstanceId: "client_abcdefghijklmnop",
      attachmentGeneration: 1,
      controllerLeaseGeneration: 9,
      deviceGeneration: 7
    })
    expect(value.calls).toHaveLength(1)
    expect(value.calls[0]?.url).toContain(
      `/v1/devices/${device.deviceId}/sessions/session_abcdefghijklmnop`
    )
  })

  it("accepts a released client grant shape without weakening account authentication", async () => {
    const value = harness()
    const response = await value.app.request("/api/devices/grants", {
      method: "POST",
      headers: {
        authorization: "Bearer better-auth-desktop-bearer",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        version: 1,
        audience: "session-tunnel",
        deviceId: device.deviceId,
        sessionId: "session_legacy_abcdefgh"
      })
    })
    expect(response.status).toBe(200)
    const body: DeviceRelayGrantResponse = await response.json()
    expect(body.claims).toMatchObject({
      subject: "user-one",
      clientInstanceId: expect.stringMatching(/^legacy_/u),
      attachmentGeneration: 1,
      controllerLeaseGeneration: 1
    })
  })

  it("exchanges a valid device signature for a short-lived device grant", async () => {
    const value = harness()
    const challenge = {
      version: 1,
      challengeId: "challenge_abcdefghijklmnop",
      subject: "user-one",
      deviceId: device.deviceId,
      nonce: "A".repeat(43),
      issuedAt: 100,
      expiresAt: 220
    }
    const response = await value.app.request(
      "/api/devices/challenges/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          challenge,
          signature: "A".repeat(86)
        })
      }
    )
    expect(response.status).toBe(200)
    const body: DeviceRelayGrantResponse = await response.json()
    expect(
      verifyDeviceGrant(body.grant, signingSecret, "device-connect", 200)
    ).toMatchObject({
      subject: "user-one",
      deviceId: device.deviceId,
      deviceGeneration: 7,
      sessionId: null
    })
    const exchangeClaims = verifyDeviceGrant(
      relayGrant(value.calls[0]!),
      signingSecret,
      "device-challenge",
      200
    )
    expect(exchangeClaims).toMatchObject({
      subject: challenge.subject,
      deviceId: challenge.deviceId,
      deviceGeneration: null
    })
  })

  it("returns 503 when the dedicated relay is disabled or incomplete", async () => {
    const value = harness()
    const disabled = new Hono().route(
      "/api/devices",
      createDeviceRoutes(() => ({ ...value.dependencies, enabled: false }))
    )
    const response = await disabled.fetch(authenticated("/api/devices"))
    expect(response.status).toBe(503)
  })
})
