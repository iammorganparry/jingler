import { describe, expect, it, vi } from "vitest"
import { applyManagedAuthorizationSnapshot } from "./authorization.js"
import { issueManagedRuntimeGrant, verifyManagedRuntimeGrant } from "./grant.js"

const secret = "managed-runtime-authorization-secret-at-least-32-bytes"

const issued = () =>
  issueManagedRuntimeGrant(
    {
      subject: "user_123",
      environmentId: "managed_123",
      sessionId: "session_123",
      actions: ["session.input"],
      authStateVersion: 4,
      environmentGeneration: 2,
      sessionGeneration: 3
    },
    secret,
    100,
    "grant_authorization"
  )

describe("managed runtime authorization fencing", () => {
  it("stops active process when auth revoked", async () => {
    const stop = vi.fn(async () => undefined)
    const next = await applyManagedAuthorizationSnapshot(
      {
        authStateVersion: 4,
        sessionGeneration: 3,
        processId: "process_1",
        authorized: true
      },
      null,
      stop
    )
    expect(stop).toHaveBeenCalledExactlyOnceWith("process_1")
    expect(next).toEqual({
      authStateVersion: 4,
      sessionGeneration: 4,
      processId: null,
      authorized: false
    })
  })

  it("rejects stale auth version", async () => {
    const grant = await issued()
    await expect(
      verifyManagedRuntimeGrant(
        grant.grant,
        secret,
        {
          action: "session.input",
          authStateVersion: 5,
          environmentGeneration: 2,
          sessionGeneration: 3
        },
        101
      )
    ).resolves.toEqual({ ok: false, reason: "wrong-auth-version" })
  })

  it("rejects stale generation", async () => {
    const grant = await issued()
    await expect(
      verifyManagedRuntimeGrant(
        grant.grant,
        secret,
        {
          action: "session.input",
          authStateVersion: 4,
          environmentGeneration: 2,
          sessionGeneration: 4
        },
        101
      )
    ).resolves.toEqual({ ok: false, reason: "stale-session" })
  })
})
