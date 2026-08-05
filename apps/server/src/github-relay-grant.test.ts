import { describe, expect, it } from "vitest"
import {
  issueGitHubRelayGrant,
  verifyGitHubRelayGrant
} from "./github-relay-grant.js"

const config = {
  relayUrl: "https://relay.jingler.dev",
  relaySigningSecret: "relay-secret-that-is-long-and-random",
  ttlSeconds: 300
}

describe("GitHub relay grants", () => {
  it("issues a short-lived installation-scoped grant without a GitHub credential", () => {
    const response = issueGitHubRelayGrant(
      { userId: "user-1", installationId: "99" },
      config,
      100,
      "grant-1"
    )
    expect(response).toMatchObject({
      relayUrl: config.relayUrl,
      claims: {
        subject: "user-1",
        installationId: "99",
        issuedAt: 100,
        expiresAt: 400,
        grantId: "grant-1"
      }
    })
    expect(JSON.stringify(response)).not.toMatch(/gh[ours]_/)
    expect(verifyGitHubRelayGrant(response.grant, config.relaySigningSecret, 399)).toEqual(
      response.claims
    )
  })

  it("rejects altered, expired, wrong-secret, and future-issued grants", () => {
    const response = issueGitHubRelayGrant(
      { userId: "user-1", installationId: "99" },
      config,
      100,
      "grant-1"
    )
    expect(() => verifyGitHubRelayGrant(`${response.grant}x`, config.relaySigningSecret, 200)).toThrow(
      "invalid-grant"
    )
    expect(() => verifyGitHubRelayGrant(response.grant, "wrong", 200)).toThrow("invalid-grant")
    expect(() => verifyGitHubRelayGrant(response.grant, config.relaySigningSecret, 400)).toThrow(
      "invalid-grant"
    )
    const future = issueGitHubRelayGrant(
      { userId: "user-1", installationId: "99" },
      config,
      500,
      "grant-future"
    )
    expect(() => verifyGitHubRelayGrant(future.grant, config.relaySigningSecret, 200)).toThrow(
      "invalid-grant"
    )
  })
})
