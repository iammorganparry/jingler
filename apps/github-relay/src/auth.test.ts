import { describe, expect, it } from "vitest"
import { bearerGrant, verifyRelayGrant } from "./auth.js"
import { issueTestRelayGrant } from "./test-support.js"

describe("relay grant verification", () => {
  it("accepts a valid audience-bound, unexpired server grant", async () => {
    const grant = await issueTestRelayGrant()
    await expect(verifyRelayGrant(grant, "test-relay-signing-secret", 200)).resolves.toMatchObject({
      subject: "user-1",
      installationId: "99",
      grantId: "grant-1"
    })
  })

  it("rejects alteration, wrong secrets, expiry, future issue times, and malformed values", async () => {
    const grant = await issueTestRelayGrant()
    await expect(verifyRelayGrant(`${grant}x`, "test-relay-signing-secret", 200)).resolves.toBeNull()
    await expect(verifyRelayGrant(grant, "wrong", 200)).resolves.toBeNull()
    await expect(verifyRelayGrant(grant, "test-relay-signing-secret", 400)).resolves.toBeNull()
    await expect(
      verifyRelayGrant(
        await issueTestRelayGrant({ issuedAt: 500, expiresAt: 600 }),
        "test-relay-signing-secret",
        200
      )
    ).resolves.toBeNull()
    await expect(verifyRelayGrant("not-a-grant", "test-relay-signing-secret", 200)).resolves.toBeNull()
  })

  it("only accepts an explicit bearer credential", () => {
    expect(bearerGrant(new Request("https://relay.test", { headers: { authorization: "Bearer abc" } }))).toBe("abc")
    expect(bearerGrant(new Request("https://relay.test?grant=abc"))).toBeNull()
  })
})
