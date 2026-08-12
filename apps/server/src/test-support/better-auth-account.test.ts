import { describe, expect, it } from "vitest"
import { createBetterAuthTestAccount } from "./better-auth-account.js"

describe("Better Auth test account", () => {
  it("creates an authenticated bearer session without an email round trip", async () => {
    const account = await createBetterAuthTestAccount()

    const session = await account.auth.api.getSession({
      headers: account.headers
    })

    expect(session).toMatchObject({
      user: {
        id: account.userId,
        email: account.email,
        emailVerified: true
      }
    })
    expect(account.token).not.toBe("")
  })
})
