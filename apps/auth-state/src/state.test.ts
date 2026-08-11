import { describe, expect, it } from "vitest"
import {
  emptyAuthState,
  removeExpired,
  resolveCredential,
  snapshotOf,
  type AuthStateRecord
} from "./state.js"

const state = (now: number): AuthStateRecord => ({
  ...emptyAuthState("user_1"),
  sessions: { session_1: { id: "session_1", expiresAt: now + 600 } },
  credentials: {
    codex: {
      provider: "codex",
      handle: "capability_opaque",
      fingerprint: "fingerprint_opaque",
      authorizationHeaderEncrypted: "v1.encrypted-secret",
      expiresAt: now + 300
    }
  }
})

describe("auth state", () => {
  it("exposes only an opaque capability while the account session is active", () => {
    const snapshot = snapshotOf(state(1_000), 1_000)
    expect(snapshot.capabilities).toEqual(["managed.session.execute"])
    expect(snapshot.credentialCapabilities).toEqual([
      { provider: "codex", handle: "capability_opaque", expiresAt: 1_300 }
    ])
    expect(JSON.stringify(snapshot)).not.toContain("encrypted-secret")
  })

  it("fails closed after account session expiry", () => {
    const expired = removeExpired(state(1_000), 2_000)
    expect(snapshotOf(expired, 2_000).capabilities).toEqual([])
    expect(resolveCredential(expired, "codex", "capability_opaque", 2_000)).toBeNull()
  })

  it("rejects stale or mismatched capability handles", () => {
    expect(resolveCredential(state(1_000), "codex", "wrong", 1_000)).toBeNull()
    expect(resolveCredential(state(1_000), "github", "capability_opaque", 1_000)).toBeNull()
  })

  it("admits managed execution from Claude subscription auth", () => {
    const now = 1_000
    const claude: AuthStateRecord = {
      ...emptyAuthState("user_1"),
      sessions: { session_1: { id: "session_1", expiresAt: now + 600 } },
      credentials: {
        claude: {
          provider: "claude",
          handle: "capability_claude",
          fingerprint: "fingerprint_claude",
          authorizationHeaderEncrypted: "v1.encrypted-secret",
          upstream: "anthropic-api",
          expiresAt: now + 300
        }
      }
    }
    expect(snapshotOf(claude, now)).toMatchObject({
      capabilities: ["managed.session.execute"],
      credentialCapabilities: [expect.objectContaining({ provider: "claude" })]
    })
  })
})
