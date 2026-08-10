import { describe, expect, it, vi } from "vitest"
import {
  deleteAuthStateSession,
  upsertAuthStateSession
} from "./auth-state-client.js"

const session = {
  id: "session_1",
  userId: "user/1",
  expiresAt: new Date("2026-08-10T18:00:00Z")
}

describe("auth-state client", () => {
  it("routes session state directly to the user's Durable Object", async () => {
    let sentUrl = ""
    let sentInit: RequestInit | undefined
    const request: typeof fetch = async (input, init) => {
      sentUrl = String(input)
      sentInit = init
      return new Response(null, { status: 204 })
    }
    await upsertAuthStateSession(
      {
        enabled: true,
        url: "https://auth-state.jingler.dev",
        serviceSecret: "secret",
        fetch: request
      },
      session
    )
    expect(sentUrl).toBe("https://auth-state.jingler.dev/v1/internal/users/user%2F1/session")
    expect(sentInit?.method).toBe("PUT")
    expect(JSON.parse(String(sentInit?.body))).toEqual({
      sessionId: "session_1",
      expiresAt: 1_786_384_800
    })
  })

  it("fails sign-out fencing when the authority cannot revoke", async () => {
    await expect(
      deleteAuthStateSession(
        {
          enabled: true,
          url: "https://auth-state.jingler.dev",
          serviceSecret: "secret",
          fetch: async () => new Response(null, { status: 503 })
        },
        session
      )
    ).rejects.toThrow("Auth-state session sync failed (503)")
  })

  it("does not issue network traffic while managed environments are disabled", async () => {
    const request = vi.fn()
    await upsertAuthStateSession(
      {
        enabled: false,
        url: "http://localhost:9450",
        serviceSecret: "secret",
        fetch: request
      },
      session
    )
    expect(request).not.toHaveBeenCalled()
  })
})
