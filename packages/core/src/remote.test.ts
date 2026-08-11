import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ClientAttachment,
  AccountDeviceListResponse,
  ControllerLease,
  DeviceBootstrapConfiguration,
  DeviceClaim,
  DeviceControlPlaneError,
  DeviceRegistrationRequest,
  DeviceRegistrationResponse,
  RelayUsage,
  DeviceRelayGrantClaims,
  EncryptedTunnelEnvelope,
  PendingDeviceRegistrationRequest,
  RemoteDevice,
  RemoteSessionInventory,
  TunnelClientMessage,
  managedRuntimeActionForOperation
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
  maxConcurrentSessions: 2
} as const

describe("managed runtime actions", () => {
  it("uses one operation mapping for grants and runtime admission", () => {
    expect(managedRuntimeActionForOperation("Sessions.create")).toBe("session.start")
    expect(managedRuntimeActionForOperation("Sessions.continueOnEnvironment")).toBe("session.start")
    expect(managedRuntimeActionForOperation("Agent.stop")).toBe("session.cancel")
    expect(managedRuntimeActionForOperation("Sessions.transcriptPage")).toBe("session.observe")
    expect(managedRuntimeActionForOperation("Sessions.diff")).toBe("session.observe")
    expect(managedRuntimeActionForOperation("Workspace.files")).toBe("session.observe")
    expect(managedRuntimeActionForOperation("Workspace.importHandoff")).toBe("session.input")
    expect(managedRuntimeActionForOperation("Agent.run")).toBe("session.input")
  })
})

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
      clientInstanceId: "client_abcdefghijklmnop",
      attachmentGeneration: 2,
      controllerLeaseGeneration: 3,
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

describe("authoritative device control plane contracts", () => {
  it("validates account-owned registry enrollment presence and usage contracts", () => {
    const registration = {
      version: 1,
      credentialId: "claim_abcdefghijklmnop",
      registration: {
        version: 1,
        displayName: "Owned machine",
        platform: { os: "linux", arch: "arm64" },
        publicKey: {
          algorithm: "Ed25519",
          encoding: "base64url",
          value: "A".repeat(43)
        },
        capabilities: {
          version: 1,
          capabilities: ["session.start"],
          maxConcurrentSessions: 2
        }
      }
    }
    expect(Either.isRight(decode(DeviceRegistrationRequest, registration))).toBe(true)
    const device = {
      deviceId: "device_abcdefghijklmnop",
      accountId: "account_abcdefghijklmnop",
      identityFingerprint: "A".repeat(43),
      ...registration.registration,
      state: "active",
      generation: 1,
      enrolledAt: 100,
      createdAt: 100,
      updatedAt: 100,
      revokedAt: null
    }
    expect(
      Either.isRight(decode(DeviceRegistrationResponse, { version: 1, device }))
    ).toBe(true)
    expect(
      Either.isRight(
        decode(AccountDeviceListResponse, {
          version: 1,
          devices: [{
            ...device,
            presence: {
              version: 1,
              deviceId: device.deviceId,
              state: "reconnecting",
              connectedAt: null,
              lastSeenAt: 110,
              activeSessionIds: []
            }
          }]
        })
      )
    ).toBe(true)
    expect(
      Either.isRight(
        decode(RelayUsage, {
          version: 1,
          accountId: device.accountId,
          deviceId: device.deviceId,
          clientInstanceId: "client_abcdefghijklmnop",
          ciphertextBytesIn: 10,
          ciphertextBytesOut: 20,
          activeAttachments: 1,
          quotaBytes: 1_000,
          measuredAt: 120
        })
      )
    ).toBe(true)
  })

  it("validates secret-free bootstrap metadata and typed failures", () => {
    const bootstrap = {
      version: 1,
      enabled: true,
      relayOrigin: "https://relay.jingler.dev",
      protocols: ["jingler-device-v1", "jingler-session-v1"],
      issuedAt: 100,
      expiresAt: 160,
      cacheMaxAgeSeconds: 60
    }
    expect(Either.isRight(decode(DeviceBootstrapConfiguration, bootstrap))).toBe(true)
    expect(
      Either.isLeft(
        decode(DeviceBootstrapConfiguration, {
          ...bootstrap,
          relayOrigin: "https://relay.jingler.dev/path"
        })
      )
    ).toBe(true)
    const error = new DeviceControlPlaneError({
      reason: "stale-controller",
      message: "Controller generation changed",
      retryable: true
    })
    expect(
      Either.isRight(
        decode(
          DeviceControlPlaneError,
          Schema.encodeSync(DeviceControlPlaneError)(error)
        )
      )
    ).toBe(true)
  })

  it("binds claims, attachments, inventory, and leases to explicit identities", () => {
    const claim = {
      version: 1,
      claimId: "claim_abcdefghijklmnop",
      subject: "account_abcdefghijklmnop",
      deviceId: "device_abcdefghijklmnop",
      clientInstanceId: "client_abcdefghijklmnop",
      audience: "device-claim",
      issuedAt: 100,
      expiresAt: 160
    }
    expect(Either.isRight(decode(DeviceClaim, claim))).toBe(true)

    const attachment = {
      version: 1,
      attachmentId: "attachment_abcdefghijklmnop",
      subject: claim.subject,
      deviceId: claim.deviceId,
      sessionId: "session_abcdefghijklmnop",
      clientInstanceId: claim.clientInstanceId,
      mode: "controller",
      generation: 2,
      controllerLeaseGeneration: 3,
      attachedAt: 100,
      expiresAt: 160
    }
    expect(Either.isRight(decode(ClientAttachment, attachment))).toBe(true)
    expect(
      Either.isRight(
        decode(ControllerLease, {
          version: 1,
          subject: claim.subject,
          deviceId: claim.deviceId,
          sessionId: attachment.sessionId,
          ownerClientInstanceId: claim.clientInstanceId,
          generation: 3,
          acquiredAt: 100,
          expiresAt: 160
        })
      )
    ).toBe(true)
    expect(
      Either.isRight(
        decode(RemoteSessionInventory, {
          version: 1,
          deviceId: claim.deviceId,
          generatedAt: 120,
          sessions: [
            {
              version: 1,
              sessionId: attachment.sessionId,
              state: "running",
              controllerClientInstanceId: claim.clientInstanceId,
              controllerLeaseGeneration: 3,
              updatedAt: 120
            }
          ]
        })
      )
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
