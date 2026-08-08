import type { DeviceRelayGrantResponse } from "@jingler/core"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { issueDeviceGrant, verifyDeviceGrant } from "./device-grant.js"
import {
  createDeviceRoutes,
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
    harnesses: ["codex"],
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
    return Response.json({ accepted: true })
  }
) => {
  const calls: RelayCall[] = []
  let grantSequence = 0
  const dependencies: DeviceRoutesDependencies = {
    enabled: true,
    configured: true,
    relayUrl,
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
    relayFetch: async (input, init) => {
      const headers = new Headers(init.headers)
      calls.push({
        url: input,
        method: init.method ?? "GET",
        authorization: headers.get("authorization"),
        body: typeof init.body === "string" ? init.body : null
      })
      return relayHandler(new URL(input), init)
    }
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
      ...Object.fromEntries(new Headers(init.headers).entries())
    }
  })

const relayGrant = (call: RelayCall): string => {
  expect(call.authorization).toMatch(/^Bearer /)
  return call.authorization!.slice("Bearer ".length)
}

describe("device server routes", () => {
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
          displayName: "Clive mini"
        })
      })
    )
    expect(response.status).toBe(200)
    expect(value.calls).toHaveLength(1)
    expect(value.calls[0]?.url).toBe(
      `${relayUrl}/v1/devices/${device.deviceId}/rename`
    )
    expect(value.calls[0]?.body).toContain("Clive mini")
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

  it("looks up the authoritative generation before issuing a session tunnel grant", async () => {
    const value = harness()
    const response = await value.app.fetch(
      authenticated("/api/devices/grants", {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          audience: "session-tunnel",
          deviceId: device.deviceId,
          sessionId: "session_abcdefghijklmnop"
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
      deviceGeneration: 7
    })
    expect(value.calls).toHaveLength(1)
    expect(
      verifyDeviceGrant(
        relayGrant(value.calls[0]!),
        signingSecret,
        "device-control",
        200
      )
    ).toMatchObject({ subject: "user-one" })
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
