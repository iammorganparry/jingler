import { describe, expect, it } from "vitest"
import {
  GITHUB_SESSION_RELAY_GRANT_TTL_SECONDS,
  issueGitHubRelayGrant,
  issueGitHubSessionRelayGrant,
  verifyGitHubSessionRelayGrant,
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

  it("issues a grant scoped to one opaque relay session", () => {
    const response = issueGitHubSessionRelayGrant(
      {
        userId: "user-1",
        installationId: "99",
        relaySessionId: "opaque_session_identifier_123"
      },
      config,
      100,
      "grant-session"
    )
    expect(verifyGitHubSessionRelayGrant(response.grant, config.relaySigningSecret, 399)).toEqual(
      response.claims
    )
    expect(response.claims).toMatchObject({
      subject: "user-1",
      installationId: "99",
      relaySessionId: "opaque_session_identifier_123"
    })
    expect(JSON.stringify(response)).not.toContain("local-session")
  })

  it("keeps a session grant alive for one hour by default to limit reconnect churn", () => {
    const response = issueGitHubSessionRelayGrant(
      {
        userId: "user-1",
        installationId: "99",
        relaySessionId: "opaque_session_identifier_456"
      },
      {
        relayUrl: config.relayUrl,
        relaySigningSecret: config.relaySigningSecret
      },
      100,
      "grant-session-hour"
    )

    expect(response.claims.expiresAt).toBe(100 + GITHUB_SESSION_RELAY_GRANT_TTL_SECONDS)
    expect(
      verifyGitHubSessionRelayGrant(
        response.grant,
        config.relaySigningSecret,
        response.claims.expiresAt - 1
      )
    ).toEqual(response.claims)
  })
})
