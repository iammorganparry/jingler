import { describe, expect, it } from "vitest"
import {
  type ClaudeCliCredentialSources,
  readLocalClaudeCliAccessToken
} from "./claude-cli-credentials.js"

const NOW = 1_800_000_000_000

const sources = (overrides: Partial<ClaudeCliCredentialSources>): ClaudeCliCredentialSources => ({
  readKeychain: async () => null,
  readCredentialsFile: async () => null,
  now: () => NOW,
  ...overrides
})

const credentialJson = (expiresAt: number | null) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "cli-access-token",
      refreshToken: "cli-refresh-token",
      expiresAt,
      scopes: ["user:inference", "user:profile"]
    }
  })

describe("readLocalClaudeCliAccessToken", () => {
  it("reads the keychain credential first", async () => {
    const token = await readLocalClaudeCliAccessToken(
      sources({
        readKeychain: async () => credentialJson(NOW + 3_600_000),
        readCredentialsFile: async () => {
          throw new Error("must not fall through")
        }
      })
    )
    expect(token).toBe("cli-access-token")
  })

  it("falls through to the credentials file when the keychain is empty", async () => {
    const token = await readLocalClaudeCliAccessToken(
      sources({ readCredentialsFile: async () => credentialJson(null) })
    )
    expect(token).toBe("cli-access-token")
  })

  it("rejects an expired token instead of guaranteeing a 401", async () => {
    const token = await readLocalClaudeCliAccessToken(
      sources({ readKeychain: async () => credentialJson(NOW - 1) })
    )
    expect(token).toBeNull()
  })

  it("degrades unreadable or unexpected payloads to null", async () => {
    expect(
      await readLocalClaudeCliAccessToken(
        sources({ readKeychain: async () => "not json" })
      )
    ).toBeNull()
    expect(
      await readLocalClaudeCliAccessToken(
        sources({ readKeychain: async () => JSON.stringify({ other: true }) })
      )
    ).toBeNull()
    expect(
      await readLocalClaudeCliAccessToken(
        sources({
          readKeychain: async () => {
            throw new Error("keychain locked")
          }
        })
      )
    ).toBeNull()
  })
})
