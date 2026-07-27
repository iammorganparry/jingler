import { describe, expect, it } from "vitest"
import { findDeepLinkInArgv, parseAuthCallback } from "./deep-link.js"

/**
 * The deep-link parsers are pure (no Electron), so they're unit-tested directly.
 * They decide whether an inbound URL/argv is a sign-in callback and extract the
 * token or error the main process then acts on.
 */
describe("parseAuthCallback", () => {
  it("extracts the token from a valid callback", () => {
    expect(parseAuthCallback("jingler://auth/callback?token=abc123")).toEqual({
      token: "abc123",
      error: null
    })
  })

  it("extracts an error when sign-in failed", () => {
    expect(parseAuthCallback("jingler://auth/callback?error=nosession")).toEqual({
      token: null,
      error: "nosession"
    })
  })

  it("rejects a non-jingler scheme", () => {
    expect(parseAuthCallback("https://auth/callback?token=abc")).toBeNull()
  })

  it("rejects a jingler URL that isn't the auth host", () => {
    expect(parseAuthCallback("jingler://open/session?token=abc")).toBeNull()
  })

  it("rejects an unparseable URL", () => {
    expect(parseAuthCallback("not a url")).toBeNull()
  })
})

describe("findDeepLinkInArgv", () => {
  it("finds a jingler link among other argv entries", () => {
    expect(
      findDeepLinkInArgv(["/path/electron", "--flag", "jingler://auth/callback?token=x"])
    ).toBe("jingler://auth/callback?token=x")
  })

  it("returns null when no deep link is present", () => {
    expect(findDeepLinkInArgv(["/path/electron", "--flag"])).toBeNull()
  })
})
