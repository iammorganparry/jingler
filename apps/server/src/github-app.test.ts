import { createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, verify } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { loadEnv } from "./env.js"
import {
  createGitHubAppClient,
  createGitHubAppJwt,
  createGitHubTokenCipher,
  GitHubAppError,
  issueGitHubDesktopGrant,
  verifyGitHubDesktopGrant
} from "./github-app.js"

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()

const legacyTokenEnvelope = (rootSecret: string, plaintext: string): string => {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(rootSecret),
      Buffer.from("jingler-github-app"),
      Buffer.from("user-token-encryption-v1"),
      32
    )
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".")
}

const config = {
  appId: "1234",
  clientId: "Iv1.test",
  clientSecret: "github-app-client-secret",
  privateKey,
  relayUrl: "https://relay.jingler.test",
  relaySigningSecret: "relay-signing-secret",
  apiBaseUrl: "https://api.github.test",
  webBaseUrl: "https://github.test"
}

describe("GitHub App configuration", () => {
  it("fails closed in production only when the integration is enabled but incomplete", () => {
    const production = {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "auth-secret",
      BETTER_AUTH_URL: "https://auth.jingler.test",
      MEMORY_ENABLED: "false",
      MEMORY_GRANT_SECRET: "memory-grant-secret",
      MEMORY_WORKER_SERVICE_SECRET: "memory-worker-secret",
      CRON_SECRET: "cron-secret-abcdefghijklmnopqrstuvwxyz"
    }
    expect(loadEnv(production).githubAppEnabled).toBe(false)
    expect(() => loadEnv({ ...production, GITHUB_APP_ENABLED: "true" })).toThrow(
      "GITHUB_APP is enabled but missing"
    )
    expect(
      loadEnv({
        ...production,
        GITHUB_APP_ENABLED: "true",
        GITHUB_APP_ID: "1234",
        GITHUB_APP_CLIENT_ID: "client-id",
        GITHUB_APP_CLIENT_SECRET: "client-secret",
        GITHUB_APP_PRIVATE_KEY: "line-1\\nline-2",
        GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-abcdefghijklmnopqrstuvwxyz",
        GITHUB_APP_RELAY_URL: "https://relay.jingler.test",
        GITHUB_APP_RELAY_SIGNING_SECRET: "relay-secret-abcdefghijklmnopqrstuvwxyz",
        GITHUB_APP_TOKEN_ENCRYPTION_KEY: "token-encryption-key-v2-abcdefghijk"
      })
    ).toMatchObject({
      githubAppEnabled: true,
      githubAppConfigured: true,
      githubAppPrivateKey: "line-1\nline-2"
    })
  })

  it("rejects weak or reused production GitHub secrets", () => {
    const production = {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "auth-secret",
      BETTER_AUTH_URL: "https://auth.jingler.test",
      MEMORY_ENABLED: "false",
      MEMORY_GRANT_SECRET: "memory-grant-secret",
      MEMORY_WORKER_SERVICE_SECRET: "memory-worker-secret",
      CRON_SECRET: "cron-secret-abcdefghijklmnopqrstuvwxyz",
      GITHUB_APP_ENABLED: "true",
      GITHUB_APP_ID: "1234",
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: "line-1\\nline-2",
      GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-abcdefghijklmnopqrstuvwxyz",
      GITHUB_APP_RELAY_URL: "https://relay.jingler.test",
      GITHUB_APP_RELAY_SIGNING_SECRET: "relay-secret-abcdefghijklmnopqrstuvwxyz",
      GITHUB_APP_TOKEN_ENCRYPTION_KEY: "token-encryption-key-v2-abcdefghijk"
    }
    expect(() => loadEnv({ ...production, GITHUB_APP_WEBHOOK_SECRET: "too-short" })).toThrow(
      "at least 32 bytes"
    )
    expect(() =>
      loadEnv({
        ...production,
        GITHUB_APP_RELAY_SIGNING_SECRET: production.GITHUB_APP_WEBHOOK_SECRET
      })
    ).toThrow("must be distinct")
  })
})

describe("GitHub App cryptography", () => {
  it("creates a short-lived RS256 app JWT", () => {
    const jwt = createGitHubAppJwt(config, 1_000)
    const [header, payload, signature] = jwt.split(".") as [string, string, string]
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT"
    })
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({
      iat: 940,
      exp: 1_540,
      iss: "1234"
    })
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url")
      )
    ).toBe(true)
  })

  it("encrypts user tokens with authenticated encryption and rejects tampering", () => {
    const cipher = createGitHubTokenCipher("root-secret")
    const encrypted = cipher.encrypt("ghu_user-access-secret")
    expect(encrypted).not.toContain("ghu_user-access-secret")
    expect(cipher.decrypt(encrypted)).toBe("ghu_user-access-secret")
    // Change a leading tag character. Mutating the final base64url character can
    // alter only unused padding bits and occasionally decode to identical bytes.
    const parts = encrypted.split(".")
    const tag = parts[2]!
    parts[2] = `${tag[0] === "a" ? "b" : "a"}${tag.slice(1)}`
    const tampered = parts.join(".")
    expect(() => cipher.decrypt(tampered)).toThrow(GitHubAppError)
  })

  it("decrypts previous-key envelopes during rotation independently from relay signing", () => {
    const oldCipher = createGitHubTokenCipher("old-token-key")
    const oldEnvelope = oldCipher.encrypt("ghu_rotating-secret")
    const legacyEnvelope = legacyTokenEnvelope("old-token-key", "ghu_legacy-secret")
    const rotatingCipher = createGitHubTokenCipher("new-token-key", "old-token-key")

    expect(rotatingCipher.decrypt(oldEnvelope)).toBe("ghu_rotating-secret")
    expect(rotatingCipher.decrypt(legacyEnvelope)).toBe("ghu_legacy-secret")
    const reencrypted = rotatingCipher.encrypt("ghu_rotating-secret")
    expect(reencrypted).not.toBe(oldEnvelope)
    expect(createGitHubTokenCipher("new-token-key").decrypt(reencrypted)).toBe(
      "ghu_rotating-secret"
    )
    expect(() => createGitHubTokenCipher("relay-signing-secret").decrypt(oldEnvelope)).toThrow(
      GitHubAppError
    )
  })

  it("issues audience-bound, expiring desktop grants without GitHub credentials", () => {
    const response = issueGitHubDesktopGrant(
      { userId: "user-1", installationId: "99" },
      config,
      100,
      "grant-1",
      300
    )
    expect(response.relayUrl).toBe("https://relay.jingler.test")
    expect(verifyGitHubDesktopGrant(response.grant, config.relaySigningSecret, 399)).toEqual(
      response.claims
    )
    expect(JSON.stringify(response)).not.toMatch(/gh[urs]_/)
    expect(() => verifyGitHubDesktopGrant(response.grant, "wrong", 101)).toThrow("invalid-grant")
    expect(() => verifyGitHubDesktopGrant(response.grant, config.relaySigningSecret, 400)).toThrow(
      "invalid-grant"
    )
  })
})

describe("GitHub API client", () => {
  it("rotates user tokens, reconciles installations, and mints installation tokens on demand", async () => {
    const requests: Array<{
      readonly url: string
      readonly init: RequestInit
    }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({
          access_token: "ghu_rotated",
          refresh_token: "ghr_rotated",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600
        })
      }
      if (url.endsWith("/user")) {
        return Response.json({
          id: 7,
          login: "octocat",
          name: "Octo Cat",
          avatar_url: null
        })
      }
      if (url.includes("/user/installations/99/repositories")) {
        return Response.json({
          repositories: [{ id: 301, full_name: "acme/widget" }]
        })
      }
      if (url.includes("/user/installations")) {
        return Response.json({
          installations: [
            {
              id: 99,
              account: {
                id: 8,
                login: "acme",
                type: "Organization",
                avatar_url: "avatar"
              },
              repository_selection: "selected",
              permissions: { contents: "read", pull_requests: "write" },
              suspended_at: "2026-08-01T10:00:00.000Z"
            }
          ]
        })
      }
      if (url.endsWith("/app")) return Response.json({ slug: "jingler-test" })
      if (url.endsWith("/access_tokens")) {
        return Response.json({
          token: "ghs_installation_secret",
          expires_at: "2026-08-04T11:00:00Z"
        })
      }
      if (url.endsWith("/repos/acme/widget/pulls")) {
        return Response.json({ number: 1731 }, { status: 201 })
      }
      return new Response(null, { status: 204 })
    })
    const client = createGitHubAppClient(config, {
      fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-08-04T10:00:00Z")
    })

    const rotated = await client.refreshUserToken("ghr_old")
    expect(rotated).toMatchObject({
      accessToken: "ghu_rotated",
      refreshToken: "ghr_rotated",
      accessTokenExpiresAt: new Date("2026-08-04T18:00:00Z")
    })
    expect(String(requests[0]?.init.body)).toContain("grant_type=refresh_token")

    expect(await client.getUser(rotated.accessToken)).toMatchObject({
      id: "7",
      login: "octocat"
    })
    expect(await client.listInstallations(rotated.accessToken)).toEqual([
      expect.objectContaining({
        id: "99",
        repositorySelection: "selected",
        suspendedAt: new Date("2026-08-01T10:00:00.000Z")
      })
    ])
    expect(await client.listInstallationRepositories(rotated.accessToken, "99")).toEqual([
      { id: "301", fullName: "acme/widget" }
    ])

    const beforeMint = requests.length
    const installationToken = await client.createInstallationAccessToken("99", {
      permissions: { pull_requests: "read" },
      repositories: ["widgets"]
    })
    expect(requests).toHaveLength(beforeMint + 1)
    expect(installationToken).toEqual({
      token: "ghs_installation_secret",
      expiresAt: new Date("2026-08-04T11:00:00Z")
    })
    expect(requests.at(-1)?.url.endsWith("/app/installations/99/access_tokens")).toBe(true)
    expect(JSON.parse(String(requests.at(-1)?.init.body))).toEqual({
      permissions: { pull_requests: "read" },
      repositories: ["widgets"]
    })

    const pullRequestNumber = await client.createPullRequest("ghu_connected_user", {
      repository: "acme/widget",
      title: "Fix publishing",
      body: "PR body",
      head: "acme:chore/fix-publishing",
      base: "main",
      draft: false
    })
    expect(pullRequestNumber).toBe(1731)
    expect(requests.at(-1)?.init.headers).toMatchObject({
      authorization: "Bearer ghu_connected_user"
    })
    expect(JSON.parse(String(requests.at(-1)?.init.body))).toEqual({
      title: "Fix publishing",
      body: "PR body",
      head: "acme:chore/fix-publishing",
      base: "main",
      draft: false
    })

    const afterNarrowMint = requests.length
    await expect(
      client.createInstallationAccessToken("99", {
        permissions: {},
        repositories: []
      })
    ).rejects.toMatchObject({ code: "invalid-grant" })
    await expect(
      client.createInstallationAccessToken("99", {
        permissions: { contents: "read" },
        repositories: ["widgets", "other"]
      })
    ).rejects.toMatchObject({ code: "invalid-grant" })
    expect(requests).toHaveLength(afterNarrowMint)
  })

  it("does not leak an upstream credential-bearing response in errors", async () => {
    const client = createGitHubAppClient(config, {
      fetch: async () =>
        Response.json(
          { message: "Bad credentials ghu_secret-that-must-not-escape" },
          { status: 401 }
        )
    })
    await expect(client.getUser("ghu_request-secret")).rejects.toThrow("api-rejected (401)")
    try {
      await client.getUser("ghu_request-secret")
    } catch (error) {
      expect(String(error)).not.toContain("secret-that-must-not-escape")
      expect(String(error)).not.toContain("ghu_request-secret")
    }
  })
})
