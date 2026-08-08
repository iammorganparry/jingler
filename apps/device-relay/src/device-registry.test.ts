import type {
  DevicePublicKey,
  PendingDeviceRegistrationRequest
} from "@jingler/core"
import { env, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
  type ClaimedPendingDevice,
  deviceChallengePayload,
  type DeviceRegistryObject
} from "./device-registry.js"

const pairingCode = "ABCDEFGH"

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

const keyPair = async (): Promise<{
  readonly publicKey: DevicePublicKey
  readonly privateKey: CryptoKey
}> => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify"
  ])
  if (!("privateKey" in keys)) throw new Error("Expected an Ed25519 key pair")
  return {
    publicKey: {
      algorithm: "Ed25519",
      encoding: "base64url",
      value: base64Url(
        new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
      )
    },
    privateKey: keys.privateKey
  }
}

const registration = (
  publicKey: DevicePublicKey
): PendingDeviceRegistrationRequest => ({
  version: 1,
  displayName: "Build host",
  platform: { os: "linux", arch: "x64" },
  publicKey,
  capabilities: {
    version: 1,
    capabilities: [
      "session.start",
      "session.input",
      "session.cancel",
      "session.observe"
    ],
    harnesses: ["codex"],
    maxConcurrentSessions: 2
  }
})

const registerPending = async (
  suffix: string,
  publicKey: DevicePublicKey,
  nowSeconds = 100,
  ttlSeconds = 600
) => {
  const pendingDeviceId = `pending_${suffix}`
  const deviceId = `device_${suffix}`
  const stub = env.DEVICE_REGISTRY.getByName(`pending:${pendingDeviceId}`)
  const response = await stub.registerPending(
    {
      pendingDeviceId,
      deviceId,
      pairingCode,
      registration: registration(publicKey)
    },
    nowSeconds,
    ttlSeconds
  )
  return { stub, response }
}

const claimDevice = async (
  suffix: string,
  subject: string,
  publicKey: DevicePublicKey,
  nowSeconds = 100
): Promise<{
  readonly registry: DurableObjectStub<DeviceRegistryObject>
  readonly claim: ClaimedPendingDevice
}> => {
  const pending = await registerPending(suffix, publicKey, nowSeconds)
  const result = await pending.stub.claimPending(
    subject,
    pending.response.pendingDeviceId,
    pairingCode,
    nowSeconds + 1
  )
  if (result.status !== "claimed")
    throw new Error(`Claim failed: ${result.status}`)
  const registry = env.DEVICE_REGISTRY.getByName(`user:${subject}`)
  await registry.adoptClaim(subject, result.device, nowSeconds + 1)
  return { registry, claim: result.device }
}

describe("pending device pairing", () => {
  it("claims one pending pairing code exactly once", async () => {
    const keys = await keyPair()
    const pending = await registerPending(
      "pairing_once_abcdefghijkl",
      keys.publicKey
    )

    await runInDurableObject(pending.stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{
          readonly [key: string]: SqlStorageValue
          readonly pairing_hash: string
        }>("SELECT pairing_hash FROM pending_devices")
        .one()
      expect(row.pairing_hash).not.toBe(pairingCode)
      expect(JSON.stringify(row)).not.toContain(pairingCode)
    })

    await expect(
      pending.stub.claimPending(
        "user-one",
        pending.response.pendingDeviceId,
        "ZZZZZZZZ",
        101
      )
    ).resolves.toEqual({ status: "invalid-code" })

    const first = await pending.stub.claimPending(
      "user-one",
      pending.response.pendingDeviceId,
      pairingCode,
      102
    )
    expect(first.status).toBe("claimed")
    await expect(
      pending.stub.claimPending(
        "user-one",
        pending.response.pendingDeviceId,
        pairingCode,
        103
      )
    ).resolves.toEqual({ status: "already-claimed" })
  })

  it("rejects expired pairing codes", async () => {
    const keys = await keyPair()
    const expired = await registerPending(
      "expired_abcdefghijklmnop",
      keys.publicKey,
      100,
      5
    )
    await expect(
      expired.stub.claimPending(
        "user-one",
        expired.response.pendingDeviceId,
        pairingCode,
        106
      )
    ).resolves.toEqual({ status: "expired" })
  })

  it("rejects a claim from a different user subject", async () => {
    const keys = await keyPair()
    const pending = await registerPending(
      "cross_user_abcdefghijkl",
      keys.publicKey
    )
    await expect(
      pending.stub.claimPending(
        "user-one",
        pending.response.pendingDeviceId,
        pairingCode,
        101
      )
    ).resolves.toMatchObject({ status: "claimed" })
    await expect(
      pending.stub.claimPending(
        "user-two",
        pending.response.pendingDeviceId,
        pairingCode,
        102
      )
    ).resolves.toEqual({ status: "already-claimed" })
  })

  it("rate-limits repeated pairing guesses", async () => {
    const keys = await keyPair()
    const limited = await registerPending(
      "limited_abcdefghijklmnop",
      keys.publicKey
    )
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        limited.stub.claimPending(
          "user-one",
          limited.response.pendingDeviceId,
          "ZZZZZZZZ",
          110 + attempt
        )
      ).resolves.toEqual({ status: "invalid-code" })
    }
    await expect(
      limited.stub.claimPending(
        "user-one",
        limited.response.pendingDeviceId,
        "ZZZZZZZZ",
        115
      )
    ).resolves.toEqual({ status: "rate-limited" })
    await expect(
      limited.stub.claimPending(
        "user-one",
        limited.response.pendingDeviceId,
        pairingCode,
        116
      )
    ).resolves.toEqual({ status: "rate-limited" })
  })

  it("adopts metadata into the per-user registry without exposing another registry", async () => {
    const keys = await keyPair()
    const paired = await claimDevice(
      "metadata_abcdefghijkl",
      "user-one",
      keys.publicKey
    )
    await expect(paired.registry.listDevices()).resolves.toMatchObject({
      version: 1,
      devices: [
        {
          deviceId: paired.claim.deviceId,
          displayName: "Build host",
          generation: 1,
          state: "active",
          presence: { state: "offline" }
        }
      ]
    })
    await expect(
      env.DEVICE_REGISTRY.getByName("user:user-two").listDevices()
    ).resolves.toEqual({ version: 1, devices: [] })
  })

  it("returns versioned discovery only from the owning user registry", async () => {
    const keys = await keyPair()
    const owner = "discovery-owner"
    const outsider = "discovery-outsider"
    const paired = await claimDevice("discovery_abcdefghijkl", owner, keys.publicKey)
    await runInDurableObject(paired.registry, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO device_discovery (device_id, discovery_json, updated_at) VALUES (?, ?, ?)",
        paired.claim.deviceId,
        JSON.stringify({
          version: 1,
          agentVersion: "2.0.3",
          platform: { os: "linux", arch: "x64" },
          capabilities: registration(keys.publicKey).capabilities,
          repositories: [{ name: "app", path: "/srv/app", defaultBranch: "main", currentBranch: "main", branches: ["main"], githubSlug: "acme/app" }]
        }),
        150
      )
    })
    await expect(paired.registry.getDiscovery(paired.claim.deviceId)).resolves.toMatchObject({
      version: 1,
      deviceId: paired.claim.deviceId,
      updatedAt: 150,
      discovery: { agentVersion: "2.0.3", repositories: [{ path: "/srv/app" }] }
    })
    await expect(paired.registry.listDevices()).resolves.toMatchObject({
      devices: [{ deviceId: paired.claim.deviceId, agentVersion: "2.0.3" }]
    })
    await expect(env.DEVICE_REGISTRY.getByName(`user:${outsider}`).getDiscovery(paired.claim.deviceId)).resolves.toBeNull()
  })
})

describe("device challenges, key rotation, and revocation", () => {
  it("consumes a signed device challenge once", async () => {
    const keys = await keyPair()
    const paired = await claimDevice(
      "challenge_abcdefghijkl",
      "user-one",
      keys.publicKey
    )
    const challenge = await paired.registry.createChallenge(
      paired.claim.deviceId,
      "connect",
      200
    )
    expect(challenge).not.toBeNull()
    if (!challenge) return
    const signature = base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          keys.privateKey,
          deviceChallengePayload(challenge)
        )
      )
    )
    await expect(
      paired.registry.completeChallenge(challenge, signature, 201)
    ).resolves.toMatchObject({
      status: "verified",
      subject: "user-one",
      deviceId: paired.claim.deviceId,
      generation: 1
    })
    await expect(
      paired.registry.completeChallenge(challenge, signature, 202)
    ).resolves.toEqual({
      status: "replayed"
    })
  })

  it("rotates a key by signed challenge and invalidates the old generation", async () => {
    const oldKeys = await keyPair()
    const nextKeys = await keyPair()
    const paired = await claimDevice(
      "rotation_abcdefghijkl",
      "user-one",
      oldKeys.publicKey
    )
    const challenge = await paired.registry.createChallenge(
      paired.claim.deviceId,
      "rotate-key",
      300
    )
    expect(challenge).not.toBeNull()
    if (!challenge) return
    const signature = base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          oldKeys.privateKey,
          deviceChallengePayload(challenge, nextKeys.publicKey)
        )
      )
    )
    await expect(
      paired.registry.rotateKey(challenge, nextKeys.publicKey, signature, 301)
    ).resolves.toMatchObject({ status: "verified", generation: 2 })
    await expect(
      paired.registry.assertGeneration(paired.claim.deviceId, 1)
    ).resolves.toEqual({
      active: false,
      generation: 2
    })
    await expect(
      paired.registry.assertGeneration(paired.claim.deviceId, 2)
    ).resolves.toEqual({
      active: true,
      generation: 2
    })
    await expect(
      paired.registry.getDevice(paired.claim.deviceId)
    ).resolves.toMatchObject({
      publicKey: nextKeys.publicKey
    })
  })

  it("revokes one device without affecting sibling devices", async () => {
    const firstKeys = await keyPair()
    const secondKeys = await keyPair()
    const first = await claimDevice(
      "revoke_first_abcdefgh",
      "user-one",
      firstKeys.publicKey
    )
    const second = await claimDevice(
      "revoke_second_abcdefg",
      "user-one",
      secondKeys.publicKey
    )
    await first.registry.registerSession(
      first.claim.deviceId,
      1,
      "session_first_abcdefgh",
      200
    )
    await second.registry.registerSession(
      second.claim.deviceId,
      1,
      "session_second_abcdefg",
      200
    )

    await expect(
      first.registry.revokeDevice(first.claim.deviceId, 201)
    ).resolves.toMatchObject({
      state: "revoked",
      generation: 2
    })
    await expect(
      first.registry.assertGeneration(first.claim.deviceId, 1)
    ).resolves.toEqual({
      active: false,
      generation: 2
    })
    await expect(
      second.registry.assertGeneration(second.claim.deviceId, 1)
    ).resolves.toEqual({
      active: true,
      generation: 1
    })
  })

  it("persists a renamed device without changing its identity or generation", async () => {
    const keys = await keyPair()
    const paired = await claimDevice(
      "rename_abcdefghijkl",
      "user-one",
      keys.publicKey
    )
    await expect(
      paired.registry.renameDevice(paired.claim.deviceId, "Clive mini", 201)
    ).resolves.toMatchObject({
      deviceId: paired.claim.deviceId,
      displayName: "Clive mini",
      generation: 1,
      state: "active"
    })
    const listed = await paired.registry.listDevices()
    expect(
      listed.devices.find((device) => device.deviceId === paired.claim.deviceId)
    ).toMatchObject({
      deviceId: paired.claim.deviceId,
      displayName: "Clive mini",
      generation: 1
    })
  })

  it("increments the device generation on revocation", async () => {
    const keys = await keyPair()
    const paired = await claimDevice(
      "generation_abcdefghijkl",
      "user-one",
      keys.publicKey
    )
    await expect(
      paired.registry.assertGeneration(paired.claim.deviceId, 1)
    ).resolves.toEqual({
      active: true,
      generation: 1
    })
    await expect(
      paired.registry.revokeDevice(paired.claim.deviceId, 200)
    ).resolves.toMatchObject({
      state: "revoked",
      generation: 2
    })
    await expect(
      paired.registry.assertGeneration(paired.claim.deviceId, 1)
    ).resolves.toEqual({
      active: false,
      generation: 2
    })
  })

  it("persists presence and bounds the per-user audit history", async () => {
    const keys = await keyPair()
    const paired = await claimDevice(
      "presence_abcdefghijkl",
      "user-one",
      keys.publicKey
    )
    await expect(
      paired.registry.setPresence(paired.claim.deviceId, 1, "online", 200)
    ).resolves.toBe(true)
    await expect(
      paired.registry.getDevice(paired.claim.deviceId)
    ).resolves.toMatchObject({
      presence: { state: "online", connectedAt: 200, lastSeenAt: 200 }
    })

    for (let index = 0; index < 505; index += 1) {
      await paired.registry.adoptClaim(
        "user-one",
        {
          ...paired.claim,
          pendingDeviceId: `pending_audit_${index}`,
          deviceId: `device_audit_${index}`,
          createdAt: 300 + index
        },
        300 + index
      )
    }
    await expect(paired.registry.auditCount()).resolves.toBe(500)
  })

  it("admits a hibernatable device socket and closes it on revocation", async () => {
    const current = Math.floor(Date.now() / 1_000)
    const keys = await keyPair()
    const paired = await claimDevice(
      "socket_revocation_abcdef",
      "user-one",
      keys.publicKey,
      current
    )
    const response = await paired.registry.fetch(
      new Request("https://relay.internal/device", {
        headers: {
          Upgrade: "websocket",
          "x-jingler-subject": "user-one",
          "x-jingler-device-id": paired.claim.deviceId,
          "x-jingler-device-generation": "1",
          "x-jingler-expires-at": String(current + 300)
        }
      })
    )
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    const hello = new Promise<Record<string, unknown>>((resolve) =>
      socket.addEventListener("message", (event) =>
        resolve(JSON.parse(String(event.data)))
      )
    )
    socket.accept()
    await expect(hello).resolves.toMatchObject({
      type: "hello",
      generation: 1
    })
    await expect(
      paired.registry.getDevice(paired.claim.deviceId)
    ).resolves.toMatchObject({
      presence: { state: "online" }
    })

    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event))
    )
    await paired.registry.revokeDevice(paired.claim.deviceId, current + 1)
    await expect(closed).resolves.toMatchObject({
      code: 4003,
      reason: "Device revoked"
    })

    const reconnect = await paired.registry.fetch(
      new Request("https://relay.internal/device", {
        headers: {
          Upgrade: "websocket",
          "x-jingler-subject": "user-one",
          "x-jingler-device-id": paired.claim.deviceId,
          "x-jingler-device-generation": "1",
          "x-jingler-expires-at": String(current + 300)
        }
      })
    )
    expect(reconnect.status).toBe(403)
  })
})
