import { describe, expect, it } from "vitest"
import {
  DeviceGrantError,
  issueDeviceGrant,
  verifyDeviceGrant
} from "./device-grant.js"

const config = {
  relayUrl: "https://device-relay.jingler.dev",
  signingSecret: "device-relay-secret-at-least-32-bytes",
  ttlSeconds: 300
}

describe("device relay grants", () => {
  it("issues audience- and resource-scoped control, challenge, device, and tunnel grants", () => {
    const grants = [
      issueDeviceGrant(
        {
          audience: "device-control",
          subject: "user-one",
          deviceId: null,
          sessionId: null,
          deviceGeneration: null
        },
        config,
        100,
        "grant-control"
      ),
      issueDeviceGrant(
        {
          audience: "device-challenge",
          subject: "user-one",
          deviceId: "device_abcdefghijklmnop",
          sessionId: null,
          deviceGeneration: null
        },
        config,
        100,
        "grant-challenge"
      ),
      issueDeviceGrant(
        {
          audience: "device-connect",
          subject: "user-one",
          deviceId: "device_abcdefghijklmnop",
          sessionId: null,
          deviceGeneration: 2
        },
        config,
        100,
        "grant-device"
      ),
      issueDeviceGrant(
        {
          audience: "session-tunnel",
          subject: "user-one",
          deviceId: "device_abcdefghijklmnop",
          sessionId: "session_abcdefghijklmnop",
          deviceGeneration: 2
        },
        config,
        100,
        "grant-session"
      )
    ]

    for (const response of grants) {
      expect(response).toMatchObject({
        version: 1,
        relayUrl: config.relayUrl,
        claims: { subject: "user-one", issuedAt: 100, expiresAt: 400 }
      })
      expect(
        verifyDeviceGrant(response.grant, config.signingSecret, response.claims.audience, 399)
      ).toEqual(response.claims)
    }
  })

  it("rejects malformed resource combinations before signing", () => {
    expect(() =>
      issueDeviceGrant(
        {
          audience: "session-tunnel",
          subject: "user-one",
          deviceId: "device_abcdefghijklmnop",
          sessionId: null,
          deviceGeneration: 1
        },
        config
      )
    ).toThrow(DeviceGrantError)
    expect(() =>
      issueDeviceGrant(
        {
          audience: "device-connect",
          subject: "user-one",
          deviceId: "device_abcdefghijklmnop",
          sessionId: "session_abcdefghijklmnop",
          deviceGeneration: 1
        },
        config
      )
    ).toThrow(DeviceGrantError)
    expect(() =>
      issueDeviceGrant(
        {
          audience: "device-control",
          subject: "user-one",
          deviceId: null,
          sessionId: null,
          deviceGeneration: null
        },
        { ...config, ttlSeconds: 901 }
      )
    ).toThrow(DeviceGrantError)
  })

  it("rejects altered, expired, and wrong-audience grants", () => {
    const response = issueDeviceGrant(
      {
        audience: "session-tunnel",
        subject: "user-one",
        deviceId: "device_abcdefghijklmnop",
        sessionId: "session_abcdefghijklmnop",
        deviceGeneration: 1
      },
      config,
      100,
      "grant-session"
    )
    expect(() =>
      verifyDeviceGrant(`${response.grant}x`, config.signingSecret, "session-tunnel", 200)
    ).toThrow("invalid-grant")
    expect(() =>
      verifyDeviceGrant(response.grant, config.signingSecret, "device-connect", 200)
    ).toThrow("invalid-grant")
    expect(() =>
      verifyDeviceGrant(response.grant, config.signingSecret, "session-tunnel", 400)
    ).toThrow("invalid-grant")
  })

  it("mints an audience-scoped desktop grant without embedding the BetterAuth token", () => {
    const response = issueDeviceGrant(
      {
        audience: "device-control",
        subject: "user-one",
        deviceId: null,
        sessionId: null,
        deviceGeneration: null
      },
      config,
      100,
      "grant-control"
    )
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain("better-auth-desktop-bearer")
    expect(serialized).not.toContain("privateKey")
    expect(serialized).not.toContain("encryptionKey")
  })
})
