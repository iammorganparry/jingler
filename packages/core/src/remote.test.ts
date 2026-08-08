import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  DeviceRelayGrantClaims,
  EncryptedTunnelEnvelope,
  PendingDeviceRegistrationRequest,
  RemoteDevice,
  TunnelClientMessage
} from "./remote.js"

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema)(value, { onExcessProperty: "error" })

const publicKey = {
  algorithm: "Ed25519",
  encoding: "base64url",
  value: "A".repeat(43)
} as const

const capabilities = {
  version: 1,
  capabilities: ["session.start", "session.observe"],
  harnesses: ["codex"],
  maxConcurrentSessions: 2
} as const

describe("remote device contracts", () => {
  it("decodes a versioned pending registration and rejects unknown revisions", () => {
    const registration = {
      version: 1,
      displayName: "Morgan's Mac",
      platform: { os: "darwin", arch: "arm64" },
      publicKey,
      capabilities
    }
    expect(Either.isRight(decode(PendingDeviceRegistrationRequest, registration))).toBe(true)
    expect(
      Either.isLeft(decode(PendingDeviceRegistrationRequest, { ...registration, version: 2 }))
    ).toBe(true)
  })

  it("models metadata, generation, and presence without a private key", () => {
    const device = {
      version: 1,
      deviceId: "device_abcdefghijklmnop",
      displayName: "Build host",
      platform: { os: "linux", arch: "x64" },
      publicKey,
      capabilities,
      state: "active",
      generation: 3,
      createdAt: 100,
      updatedAt: 120,
      presence: {
        version: 1,
        state: "online",
        connectedAt: 110,
        lastSeenAt: 120,
        activeSessionIds: ["session_abcdefghijklmnop"]
      }
    }
    expect(Either.isRight(decode(RemoteDevice, device))).toBe(true)
    expect(Object.keys(RemoteDevice.fields)).not.toContain("privateKey")
  })
})

describe("device relay grants", () => {
  it("requires audience, resource, generation, and expiry claims", () => {
    const claims = {
      version: 1,
      issuer: "jingler",
      audience: "session-tunnel",
      subject: "opaque-user-subject",
      deviceId: "device_abcdefghijklmnop",
      sessionId: "session_abcdefghijklmnop",
      deviceGeneration: 4,
      issuedAt: 100,
      expiresAt: 160,
      grantId: "grant_abcdefghijklmnop"
    }
    expect(Either.isRight(decode(DeviceRelayGrantClaims, claims))).toBe(true)
    expect(Either.isLeft(decode(DeviceRelayGrantClaims, { ...claims, audience: "github" }))).toBe(
      true
    )
    expect(
      Either.isLeft(decode(DeviceRelayGrantClaims, { ...claims, deviceGeneration: 0 }))
    ).toBe(true)
  })
})

describe("encrypted tunnel contracts", () => {
  const envelope = {
    version: 1,
    sessionId: "session_abcdefghijklmnop",
    sequence: 1,
    sender: "desktop",
    algorithm: "AES-256-GCM",
    nonce: "A".repeat(16),
    ciphertext: "encrypted_payload",
    createdAt: 100
  } as const

  it("accepts ciphertext and rejects plaintext additions", () => {
    expect(Either.isRight(decode(EncryptedTunnelEnvelope, envelope))).toBe(true)
    expect(Either.isLeft(decode(EncryptedTunnelEnvelope, { ...envelope, prompt: "secret" }))).toBe(
      true
    )
    expect(Object.keys(EncryptedTunnelEnvelope.fields)).toStrictEqual([
      "version",
      "sessionId",
      "sequence",
      "sender",
      "algorithm",
      "nonce",
      "ciphertext",
      "createdAt"
    ])
  })

  it("wraps envelopes and acknowledgements in typed client messages", () => {
    expect(
      Either.isRight(decode(TunnelClientMessage, { type: "envelope", envelope }))
    ).toBe(true)
    expect(
      Either.isRight(
        decode(TunnelClientMessage, {
          type: "ack",
          acknowledgement: {
            version: 1,
            sessionId: envelope.sessionId,
            sender: "device",
            acknowledgedSequence: 1
          }
        })
      )
    ).toBe(true)
  })
})
