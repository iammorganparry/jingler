import { describe, expect, it } from "vitest"
import {
  createBetterAuthTestAccount,
  startBetterAuthTestServer
} from "./better-auth-account.js"

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

  it("serves the account through Better Auth without registering a bypass route", async () => {
    const server = await startBetterAuthTestServer()
    try {
      const session = await fetch(`${server.url}/api/auth/get-session`, {
        headers: server.headers
      })
      expect(session.status).toBe(200)
      expect(await session.json()).toMatchObject({
        user: { id: server.userId, email: server.email, emailVerified: true }
      })

      const bypass = await fetch(`${server.url}/api/auth/test-account`)
      expect(bypass.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
