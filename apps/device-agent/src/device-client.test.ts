import type {
  DeviceEnrollmentCredentialResponse,
  DeviceRecord,
  PendingDeviceRegistrationRequest
} from "@jingler/core"
import { describe, expect, it } from "vitest"
import { exchangeDeviceEnrollment } from "./device-client.js"

const registration: PendingDeviceRegistrationRequest = {
  version: 1,
  displayName: "Build machine",
  platform: { os: "linux", arch: "x64" },
  publicKey: { algorithm: "Ed25519", encoding: "base64url", value: "a".repeat(43) },
  encryptionPublicKey: { algorithm: "X25519", encoding: "base64url", value: "b".repeat(43) },
  capabilities: {
    version: 1,
    capabilities: ["session.start", "session.input", "session.cancel", "session.observe"],
    harnesses: ["codex"],
    maxConcurrentSessions: 4
  }
}

const credential: DeviceEnrollmentCredentialResponse = {
  version: 1,
  claim: {
    version: 1,
    claimId: "claim_1",
    subject: "user_1",
    deviceId: "device_1",
    clientInstanceId: "desktop_1",
    audience: "device-claim",
    issuedAt: 100,
    expiresAt: 200
  },
  token: "opaque.enrollment.token"
}

const device: DeviceRecord = {
  version: 1,
  deviceId: "device_1",
  accountId: "user_1",
  identityFingerprint: "f".repeat(43),
  displayName: registration.displayName,
  platform: registration.platform,
  publicKey: registration.publicKey,
  encryptionPublicKey: registration.encryptionPublicKey,
  capabilities: registration.capabilities,
  state: "active",
  generation: 1,
  enrolledAt: 100,
  createdAt: 100,
  updatedAt: 100,
  revokedAt: null
}

describe("device enrollment client", () => {
  it("exchanges an opaque enrollment credential for durable device ownership", async () => {
    let requestedUrl = ""
    let requestedInit: RequestInit | undefined
    const result = await exchangeDeviceEnrollment(
      { serverUrl: "https://api.example.test", credential, registration },
      {
        fetch: async (input, init) => {
          requestedUrl = input
          requestedInit = init
          return Response.json({ version: 1, device }, { status: 201 })
        }
      }
    )

    expect(result.enrollment).toStrictEqual({
      subject: "user_1",
      deviceId: "device_1",
      serverUrl: "https://api.example.test/"
    })
    expect(requestedUrl).toBe("https://api.example.test/api/devices/enrollments/exchange")
    expect(requestedInit?.headers).toMatchObject({ authorization: `Bearer ${credential.token}` })
    expect(JSON.parse(String(requestedInit?.body))).toStrictEqual({
      version: 1,
      credentialId: credential.claim.claimId,
      registration
    })
  })

  it("reports enrollment exchange failures without credential material", async () => {
    const result = exchangeDeviceEnrollment(
      { serverUrl: "https://api.example.test", credential, registration },
      { fetch: async () => new Response(null, { status: 410 }) }
    )

    await expect(result).rejects.toMatchObject({
      _tag: "DeviceEnrollmentError",
      phase: "exchange",
      message: "Device enrollment credential expired"
    })
    await expect(result).rejects.not.toThrow(credential.token)
  })

  it("adopts the canonical id when an existing device identity is re-enrolled", async () => {
    const canonical = { ...device, deviceId: "device_canonical" }
    const result = await exchangeDeviceEnrollment(
      { serverUrl: "https://api.example.test", credential, registration },
      { fetch: async () => Response.json({ version: 1, device: canonical }, { status: 201 }) }
    )

    expect(result.enrollment.deviceId).toBe("device_canonical")
    expect(result.device.deviceId).toBe("device_canonical")
  })

  it("rejects a registration response for a different device identity", async () => {
    await expect(
      exchangeDeviceEnrollment(
        { serverUrl: "https://api.example.test", credential, registration },
        {
          fetch: async () =>
            Response.json({
              version: 1,
              device: { ...device, publicKey: { ...device.publicKey, value: "z".repeat(43) } }
            })
        }
      )
    ).rejects.toMatchObject({ phase: "response" })
  })
})
