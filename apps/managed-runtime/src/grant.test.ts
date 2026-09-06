import { describe, expect, it } from "vitest"
import { issueManagedRuntimeGrant, verifyManagedRuntimeGrant } from "./grant.js"

const secret = "managed-runtime-test-grant-secret-at-least-32-bytes"

const issue = () =>
  issueManagedRuntimeGrant(
    {
      subject: "user_123",
      environmentId: "managed_123",
      sessionId: "session_123",
      actions: ["session.start", "session.observe"],
      authStateVersion: 7,
      environmentGeneration: 3,
      sessionGeneration: 2
    },
    secret,
    100,
    "grant_123"
  )

describe("managed runtime grants", () => {
  it("rejects a missing signing secret with a typed configuration error", async () => {
    await expect(
      issueManagedRuntimeGrant(
        {
          subject: "user_123",
          environmentId: "managed_123",
          sessionId: "session_123",
          actions: ["session.start"],
          authStateVersion: 7,
          environmentGeneration: 3,
          sessionGeneration: 2
        },
        undefined
      )
    ).rejects.toThrow("Managed runtime grant secret is invalid")
  })

  it("admits a scoped short-lived grant", async () => {
    const issued = await issue()
    await expect(
      verifyManagedRuntimeGrant(
        issued.grant,
        secret,
        {
          action: "session.start",
          authStateVersion: 7,
          environmentGeneration: 3,
          sessionGeneration: 2
        },
        101
      )
    ).resolves.toMatchObject({ ok: true })
  })

  it("rejects stale auth and lifecycle generations", async () => {
    const issued = await issue()
    await expect(
      verifyManagedRuntimeGrant(
        issued.grant,
        secret,
        {
          action: "session.start",
          authStateVersion: 8,
          environmentGeneration: 3,
          sessionGeneration: 2
        },
        101
      )
    ).resolves.toEqual({ ok: false, reason: "wrong-auth-version" })
    await expect(
      verifyManagedRuntimeGrant(
        issued.grant,
        secret,
        {
          action: "session.start",
          authStateVersion: 7,
          environmentGeneration: 4,
          sessionGeneration: 2
        },
        101
      )
    ).resolves.toEqual({ ok: false, reason: "stale-environment" })
  })
})

describe("managed grant rejection precedence", () => {
  it.each([
    [{ sessionGeneration: 99, subject: "other" }, "stale-session"],
    [{ action: "session.cancel", subject: "other" }, "action-denied"],
    [{ subject: "other" }, "wrong-scope"],
    [{ environmentId: "other" }, "wrong-scope"],
    [{ sessionId: "other" }, "wrong-scope"]
  ] as const)("retains claim validation order for %j", async (override, reason) => {
    const issued = await issue()
    const expected = {
      action: "session.start" as const,
      authStateVersion: 7,
      environmentGeneration: 3,
      sessionGeneration: 2,
      ...override
    }
    expect(await verifyManagedRuntimeGrant(issued.grant, secret, expected, 101)).toEqual({ ok: false, reason })
    expect(await verifyManagedRuntimeGrant(issued.grant, secret, expected, issued.claims.expiresAt)).toEqual({ ok: false, reason: "expired" })
  })
})
