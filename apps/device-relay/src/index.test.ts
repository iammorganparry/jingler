import type {
  DeviceClaim,
  DeviceChallenge,
  DevicePublicKey,
  DeviceRelayGrantClaims,
  PairingClaimResponse,
  PendingDeviceRegistrationResponse
} from "@jingler/core"
import { env, SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { deviceChallengePayload } from "./device-registry.js"

const secret = "test-device-relay-signing-secret-at-least-32-bytes"
const encoder = new TextEncoder()

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

const jsonPart = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)))

const issueGrant = async (
  overrides: Partial<DeviceRelayGrantClaims> = {}
): Promise<string> => {
  const now = Math.floor(Date.now() / 1_000)
  const audience = overrides.audience ?? "device-control"
  const claims: DeviceRelayGrantClaims = {
    version: 1,
    issuer: "jingler",
    audience,
    subject: "user-one",
    deviceId: null,
    sessionId: null,
    clientInstanceId:
      audience === "device-control" || audience === "session-tunnel"
        ? "client_abcdefghijklmnop"
        : null,
    attachmentGeneration: audience === "session-tunnel" ? 1 : null,
    controllerLeaseGeneration: audience === "session-tunnel" ? 1 : null,
    deviceGeneration: null,
    issuedAt: now,
    expiresAt: now + 300,
    grantId: "grant_abcdefghijklmnop",
    ...overrides
  }
  const header = jsonPart({ alg: "HS256", typ: "JinglerDeviceGrant", version: 1 })
  const payload = jsonPart(claims)
  const signed = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(signed))
  )
  return `${signed}.${base64Url(signature)}`
}

const issueClaim = async (
  overrides: Partial<DeviceClaim> = {}
): Promise<{ readonly claim: DeviceClaim; readonly token: string }> => {
  const now = Math.floor(Date.now() / 1_000)
  const claim: DeviceClaim = {
    version: 1,
    claimId: `claim_${crypto.randomUUID()}`,
    subject: "user-claim-flow",
    deviceId: `device_${crypto.randomUUID()}`,
    clientInstanceId: "client_abcdefghijklmnop",
    audience: "device-claim",
    issuedAt: now,
    expiresAt: now + 300,
    ...overrides
  }
  const header = jsonPart({ alg: "HS256", typ: "JinglerDeviceClaim", version: 1 })
  const payload = jsonPart(claim)
  const signed = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(signed))
  )
  return { claim, token: `${signed}.${base64Url(signature)}` }
}

const keyPair = async (): Promise<{
  readonly publicKey: DevicePublicKey
  readonly privateKey: CryptoKey
}> => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  if (!("privateKey" in keys)) throw new Error("Expected Ed25519 keys")
  return {
    publicKey: {
      algorithm: "Ed25519",
      encoding: "base64url",
      value: base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
    },
    privateKey: keys.privateKey
  }
}

const registerAndClaim = async (
  suffix: string,
  publicKey: DevicePublicKey,
  subject = "user-one"
): Promise<PairingClaimResponse> => {
  const pendingResponse = await SELF.fetch("https://relay.test/v1/pending-devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      displayName: `Host ${suffix}`,
      platform: { os: "linux", arch: "x64" },
      publicKey,
      capabilities: {
        version: 1,
        capabilities: ["session.start", "session.input", "session.cancel", "session.observe"],
        maxConcurrentSessions: 2
      }
    })
  })
  expect(pendingResponse.status).toBe(201)
  const pending: PendingDeviceRegistrationResponse = await pendingResponse.json()
  const control = await issueGrant({ subject })
  const claimResponse = await SELF.fetch("https://relay.test/v1/pairing/claim", {
    method: "POST",
    headers: {
      authorization: `Bearer ${control}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      version: 1,
      pendingDeviceId: pending.pendingDeviceId,
      pairingCode: pending.pairingCode
    })
  })
  expect(claimResponse.status).toBe(200)
  return claimResponse.json()
}

const messages = (
  socket: WebSocket,
  count: number
): Promise<readonly Record<string, unknown>[]> =>
  new Promise((resolve, reject) => {
    const received: Record<string, unknown>[] = []
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Worker messages")), 3_000)
    socket.addEventListener("message", (message) => {
      const parsed: Record<string, unknown> = JSON.parse(String(message.data))
      received.push(parsed)
      if (received.length !== count) return
      clearTimeout(timer)
      resolve(received)
    })
  })

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
  messages(socket, 1).then(([message]) => message!)

describe("device relay HTTP authorization", () => {
  it("consumes a server-issued device claim exactly once", async () => {
    const keys = await keyPair()
    const issued = await issueClaim()
    const registration = {
      version: 1,
      displayName: "SSH host",
      platform: { os: "linux", arch: "x64" },
      publicKey: keys.publicKey,
      capabilities: {
        version: 1,
        capabilities: ["session.start"],
        maxConcurrentSessions: 1
      }
    }
    const request = () =>
      SELF.fetch("https://relay.test/v1/device-registrations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ version: 1, claim: issued.claim, registration })
      })
    const first = await request()
    const firstBody = await first.json()
    expect({ status: first.status, body: firstBody }).toMatchObject({
      status: 201,
      body: {
      device: { deviceId: issued.claim.deviceId, state: "active" }
      }
    })
    const replay = await request()
    expect(replay.status).toBe(409)
    await expect(replay.json()).resolves.toMatchObject({ reason: "replayed" })
  })

  it("rejects a fresh registration claim for a revoked device identity", async () => {
    const keys = await keyPair()
    const subject = "user-revoked-registration"
    const issued = await issueClaim({ subject })
    const registration = {
      version: 1,
      displayName: "Revoked SSH host",
      platform: { os: "linux", arch: "arm64" },
      publicKey: keys.publicKey,
      capabilities: {
        version: 1,
        capabilities: ["session.start"],
        maxConcurrentSessions: 1
      }
    }
    const register = (claim: DeviceClaim, token: string) =>
      SELF.fetch("https://relay.test/v1/device-registrations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ version: 1, claim, registration })
      })
    expect((await register(issued.claim, issued.token)).status).toBe(201)
    const control = await issueGrant({
      subject,
      deviceId: issued.claim.deviceId,
      grantId: "grant_revoke_claimed_abcd"
    })
    const revoked = await SELF.fetch(
      `https://relay.test/v1/devices/${issued.claim.deviceId}/revoke`,
      { method: "POST", headers: { authorization: `Bearer ${control}` } }
    )
    expect(revoked.status).toBe(200)

    const replacement = await issueClaim({
      subject,
      deviceId: issued.claim.deviceId
    })
    const rejected = await register(replacement.claim, replacement.token)
    expect(rejected.status).toBe(409)
    await expect(rejected.json()).resolves.toMatchObject({
      _tag: "DeviceControlPlaneError",
      reason: "revoked"
    })
  })

  it("claims a pending device once and isolates per-user registries", async () => {
    const keys = await keyPair()
    const pendingResponse = await SELF.fetch("https://relay.test/v1/pending-devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        displayName: "Pair once",
        platform: { os: "darwin", arch: "arm64" },
        publicKey: keys.publicKey,
        capabilities: {
          version: 1,
          capabilities: ["session.start"],
          maxConcurrentSessions: 1
        }
      })
    })
    const pending: PendingDeviceRegistrationResponse = await pendingResponse.json()
    const firstGrant = await issueGrant({ subject: "user-one" })
    const secondGrant = await issueGrant({ subject: "user-two", grantId: "grant_two_abcdefgh" })
    const body = JSON.stringify({
      version: 1,
      pendingDeviceId: pending.pendingDeviceId,
      pairingCode: pending.pairingCode
    })
    const first = await SELF.fetch("https://relay.test/v1/pairing/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${firstGrant}`, "content-type": "application/json" },
      body
    })
    expect(first.status).toBe(200)
    const crossUser = await SELF.fetch("https://relay.test/v1/pairing/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${secondGrant}`, "content-type": "application/json" },
      body
    })
    expect(crossUser.status).toBe(409)

    const firstList = await SELF.fetch("https://relay.test/v1/devices", {
      headers: { authorization: `Bearer ${firstGrant}` }
    })
    await expect(firstList.json()).resolves.toMatchObject({
      devices: [{ deviceId: pending.deviceId, state: "active", generation: 1 }]
    })
    const secondList = await SELF.fetch("https://relay.test/v1/devices", {
      headers: { authorization: `Bearer ${secondGrant}` }
    })
    await expect(secondList.json()).resolves.toEqual({ version: 1, devices: [] })
  })

  it("rejects a device grant on a desktop endpoint", async () => {
    const deviceGrant = await issueGrant({
      audience: "device-connect",
      deviceId: "device_abcdefghijklmnop",
      deviceGeneration: 1,
      grantId: "grant_device_abcdefgh"
    })
    const list = await SELF.fetch("https://relay.test/v1/devices", {
      headers: { authorization: `Bearer ${deviceGrant}` }
    })
    expect(list.status).toBe(401)

    const overlongGrant = await issueGrant({
      issuedAt: Math.floor(Date.now() / 1_000),
      expiresAt: Math.floor(Date.now() / 1_000) + 901,
      grantId: "grant_overlong_abcdefgh"
    })
    const overlong = await SELF.fetch("https://relay.test/v1/devices", {
      headers: { authorization: `Bearer ${overlongGrant}` }
    })
    expect(overlong.status).toBe(401)

    const deviceScopedControl = await issueGrant({
      deviceId: "device_abcdefghijklmnop",
      grantId: "grant_scoped_control_abcd"
    })
    const broadList = await SELF.fetch("https://relay.test/v1/devices", {
      headers: { authorization: `Bearer ${deviceScopedControl}` }
    })
    expect(broadList.status).toBe(403)
  })

  it("rejects a session grant for a different session", async () => {
    const tunnelGrant = await issueGrant({
      audience: "session-tunnel",
      deviceId: "device_abcdefghijklmnop",
      deviceGeneration: 1,
      sessionId: "session_exact_abcdefghij",
      grantId: "grant_tunnel_abcdefgh"
    })
    const mismatch = await SELF.fetch(
      "https://relay.test/v1/session-tunnels/session_other_abcdefghij?endpoint=desktop",
      { headers: { Upgrade: "websocket", authorization: `Bearer ${tunnelGrant}` } }
    )
    expect(mismatch.status).toBe(401)
  })

  it("coordinates passive attachments, takeover, release validation, and compact inventory", async () => {
    const keys = await keyPair()
    const subject = "user-lease-operations"
    const paired = await registerAndClaim("lease-operations", keys.publicKey, subject)
    const sessionId = "session_lease_operations_abcdef"
    const firstClient = "client_first_abcdefghijkl"
    const secondClient = "client_second_abcdefghijk"
    const firstGrant = await issueGrant({
      audience: "session-tunnel",
      subject,
      deviceId: paired.device.deviceId,
      deviceGeneration: paired.device.generation,
      sessionId,
      clientInstanceId: firstClient,
      grantId: "grant_first_lease_abcdef"
    })
    const attachment = await SELF.fetch(
      `https://relay.test/v1/session-tunnels/${sessionId}/attachments`,
      { method: "POST", headers: { authorization: `Bearer ${firstGrant}` } }
    )
    expect(attachment.status).toBe(201)
    await expect(attachment.json()).resolves.toMatchObject({
      clientInstanceId: firstClient,
      mode: "passive",
      generation: 1
    })
    const acquire = await SELF.fetch(
      `https://relay.test/v1/session-tunnels/${sessionId}/controller/acquire`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${firstGrant}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          version: 1,
          clientInstanceId: firstClient,
          expectedGeneration: 1,
          takeover: false
        })
      }
    )
    expect(acquire.status).toBe(200)
    await expect(acquire.json()).resolves.toMatchObject({
      ownerClientInstanceId: firstClient,
      generation: 1
    })

    const secondGrant = await issueGrant({
      audience: "session-tunnel",
      subject,
      deviceId: paired.device.deviceId,
      deviceGeneration: paired.device.generation,
      sessionId,
      clientInstanceId: secondClient,
      grantId: "grant_second_lease_abcdef"
    })
    await SELF.fetch(
      `https://relay.test/v1/session-tunnels/${sessionId}/attachments`,
      { method: "POST", headers: { authorization: `Bearer ${secondGrant}` } }
    )
    const takeover = await SELF.fetch(
      `https://relay.test/v1/session-tunnels/${sessionId}/controller/takeover`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondGrant}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          version: 1,
          clientInstanceId: secondClient,
          expectedGeneration: 1,
          takeover: true
        })
      }
    )
    expect(takeover.status).toBe(200)
    await expect(takeover.json()).resolves.toMatchObject({
      ownerClientInstanceId: secondClient,
      generation: 2
    })

    const staleRelease = await SELF.fetch(
      `https://relay.test/v1/session-tunnels/${sessionId}/controller/release`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${firstGrant}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          version: 1,
          clientInstanceId: firstClient,
          expectedGeneration: 1,
          takeover: false
        })
      }
    )
    expect(staleRelease.status).toBe(403)
    await expect(staleRelease.json()).resolves.toMatchObject({
      reason: "stale-controller"
    })

    const control = await issueGrant({
      subject,
      deviceId: paired.device.deviceId,
      grantId: "grant_inventory_abcdefgh"
    })
    const targeted = await SELF.fetch(
      `https://relay.test/v1/devices/${paired.device.deviceId}/sessions/${sessionId}`,
      { headers: { authorization: `Bearer ${control}` } }
    )
    expect(targeted.status).toBe(200)
    await expect(targeted.json()).resolves.toMatchObject({
      sessions: [{ sessionId, controllerLeaseGeneration: 2 }]
    })
    const otherAccount = await issueGrant({
      subject: "user-two",
      deviceId: paired.device.deviceId,
      grantId: "grant_inventory_other_account"
    })
    const hidden = await SELF.fetch(
      `https://relay.test/v1/devices/${paired.device.deviceId}/sessions/${sessionId}`,
      { headers: { authorization: `Bearer ${otherAccount}` } }
    )
    await expect(hidden.json()).resolves.toMatchObject({ sessions: [] })
  })

  it("verifies a signed nonce once before admitting a device connection", async () => {
    const keys = await keyPair()
    const paired = await registerAndClaim("challenge", keys.publicKey)
    const challengeGrant = await issueGrant({
      audience: "device-challenge",
      deviceId: paired.device.deviceId,
      grantId: "grant_challenge_abcdef"
    })
    const challengeResponse = await SELF.fetch("https://relay.test/v1/device-challenges", {
      method: "POST",
      headers: {
        authorization: `Bearer ${challengeGrant}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        version: 1,
        subject: "user-one",
        deviceId: paired.device.deviceId
      })
    })
    expect(challengeResponse.status).toBe(201)
    const challenge: DeviceChallenge = await challengeResponse.json()
    const signature = base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          keys.privateKey,
          new Uint8Array(deviceChallengePayload(challenge))
        )
      )
    )
    const exchangeBody = JSON.stringify({ version: 1, challenge, signature })
    const exchange = await SELF.fetch("https://relay.test/v1/device-challenges/exchange", {
      method: "POST",
      headers: {
        authorization: `Bearer ${challengeGrant}`,
        "content-type": "application/json"
      },
      body: exchangeBody
    })
    expect(exchange.status).toBe(200)
    await expect(exchange.json()).resolves.toMatchObject({
      status: "verified",
      subject: "user-one",
      deviceId: paired.device.deviceId,
      generation: 1
    })
    const replay = await SELF.fetch("https://relay.test/v1/device-challenges/exchange", {
      method: "POST",
      headers: {
        authorization: `Bearer ${challengeGrant}`,
        "content-type": "application/json"
      },
      body: exchangeBody
    })
    expect(replay.status).toBe(401)
  })

  it("accepts a capability announcement after device reconnect", async () => {
    const keys = await keyPair()
    const paired = await registerAndClaim("announce", keys.publicKey)
    const connectGrant = await issueGrant({
      audience: "device-connect",
      deviceId: paired.device.deviceId,
      deviceGeneration: 1,
      grantId: "grant_announce_test"
    })
    const response = await SELF.fetch("https://relay.test/v1/device-connect", {
      headers: { Upgrade: "websocket", authorization: `Bearer ${connectGrant}` }
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    socket.accept()
    await nextMessage(socket)
    socket.send(
      JSON.stringify({
        type: "announce",
        discovery: {
          version: 1,
          agentVersion: "2.0.3",
          platform: { os: "darwin", arch: "arm64" },
          capabilities: {
            version: 1,
            capabilities: ["session.start", "session.input"],
            maxConcurrentSessions: 4
          },
          repositories: [
            {
              name: "jingler",
              path: "/repos/jingler",
              defaultBranch: "main",
              currentBranch: "main",
              branches: ["main"],
              githubSlug: "iammorganparry/jingler"
            }
          ]
        }
      })
    )
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "announced" })
    const control = await issueGrant({ grantId: "grant_list_announce" })
    const listed = await SELF.fetch("https://relay.test/v1/devices", {
      headers: { authorization: `Bearer ${control}` }
    })
    const listing: { devices: Array<Record<string, unknown>> } = await listed.json()
    expect(listing.devices.find((device) => device.deviceId === paired.device.deviceId)).toMatchObject({
      deviceId: paired.device.deviceId,
      platform: { os: "darwin", arch: "arm64" },
      capabilities: { maxConcurrentSessions: 4 }
    })
    socket.close()
  })
})

describe("authorized session tunnel routing", () => {
  it("routes both endpoints to one session object and blocks reconnect after revocation", async () => {
    const keys = await keyPair()
    const paired = await registerAndClaim("tunnel", keys.publicKey)
    const sessionId = "session_routing_abcdefghij"
    const tunnelGrant = await issueGrant({
      audience: "session-tunnel",
      deviceId: paired.device.deviceId,
      deviceGeneration: 1,
      sessionId,
      grantId: "grant_session_routing"
    })
    const connectGrant = await issueGrant({
      audience: "device-connect",
      deviceId: paired.device.deviceId,
      deviceGeneration: 1,
      grantId: "grant_session_control"
    })
    const controlResponse = await SELF.fetch("https://relay.test/v1/device-connect", {
      headers: { Upgrade: "websocket", authorization: `Bearer ${connectGrant}` }
    })
    expect(controlResponse.status).toBe(101)
    const controlSocket = controlResponse.webSocket!
    controlSocket.accept()
    await nextMessage(controlSocket)
    const keyOffer = base64Url(encoder.encode(JSON.stringify({
      version: 1,
      sessionId,
      deviceId: paired.device.deviceId,
      subject: "user-one",
      ephemeralPublicKey: {
        algorithm: "X25519",
        encoding: "base64url",
        value: "A".repeat(43)
      },
      salt: "A".repeat(43)
    })))
    const connect = (endpoint: "desktop" | "device") =>
      SELF.fetch(`https://relay.test/v1/session-tunnels/${sessionId}?endpoint=${endpoint}${endpoint === "desktop" ? `&keyOffer=${keyOffer}` : ""}`, {
        headers: { Upgrade: "websocket", authorization: `Bearer ${tunnelGrant}` }
      })
    const sessionRequest = nextMessage(controlSocket)
    const desktopResponse = await connect("desktop")
    await expect(sessionRequest).resolves.toMatchObject({
      type: "session-request",
      sessionId,
      clientInstanceId: "client_abcdefghijklmnop",
      attachmentGeneration: 1,
      controllerLeaseGeneration: 1
    })
    const deviceResponse = await connect("device")
    expect(desktopResponse.status).toBe(101)
    expect(deviceResponse.status).toBe(101)
    const desktop = desktopResponse.webSocket!
    const device = deviceResponse.webSocket!
    desktop.accept()
    device.accept()
    await nextMessage(desktop)
    await nextMessage(device)
    const delivery = nextMessage(device)
    const accepted = nextMessage(desktop)
    desktop.send(
      JSON.stringify({
        type: "envelope",
        envelope: {
          version: 1,
          sessionId,
          sequence: 1,
          sender: "desktop",
          algorithm: "AES-256-GCM",
          nonce: "A".repeat(16),
          ciphertext: "encrypted_command",
          createdAt: Math.floor(Date.now() / 1_000)
        }
      })
    )
    await expect(delivery).resolves.toMatchObject({
      type: "envelope",
      envelope: { sequence: 1, ciphertext: "encrypted_command" }
    })
    await expect(accepted).resolves.toMatchObject({ type: "envelope-result", status: "inserted" })

    const desktopClosed = new Promise<CloseEvent>((resolve) =>
      desktop.addEventListener("close", (event) => resolve(event))
    )
    const deviceClosed = new Promise<CloseEvent>((resolve) =>
      device.addEventListener("close", (event) => resolve(event))
    )
    const control = await issueGrant({ deviceId: paired.device.deviceId })
    const revoked = await SELF.fetch(
      `https://relay.test/v1/devices/${paired.device.deviceId}/revoke`,
      { method: "POST", headers: { authorization: `Bearer ${control}` } }
    )
    expect(revoked.status).toBe(200)
    await expect(desktopClosed).resolves.toMatchObject({ code: 4003 })
    await expect(deviceClosed).resolves.toMatchObject({ code: 4003 })
    const reconnect = await connect("desktop")
    expect(reconnect.status).toBe(403)
    await expect(
      env.DEVICE_REGISTRY.getByName("user-one").assertGeneration(paired.device.deviceId, 1)
    ).resolves.toMatchObject({ active: false, generation: 2 })
  })
})
