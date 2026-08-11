import { describe, expect, it } from "vitest"
import { destroyRuntimeSession } from "./runtime-cleanup.js"
import type { ManagedRuntimeEnv } from "./runtime-env.js"

const envWith = (
  destroyStatus: number,
  calls: Array<{ target: string; url: string }>
): ManagedRuntimeEnv => ({
  MANAGED_SESSION: {
    getByName: (name: string) => ({
      fetch: async (url: string) => {
        calls.push({ target: name, url })
        return new Response(null, { status: destroyStatus })
      }
    })
  },
  MANAGED_ACCOUNT: {
    getByName: (name: string) => ({
      fetch: async (url: string) => {
        calls.push({ target: name, url })
        return Response.json({ ok: true })
      }
    })
  }
} as unknown as ManagedRuntimeEnv)

describe("failed runtime cleanup", () => {
  it("destroys the configured sandbox runtime without a duplicate account request", async () => {
    const calls: Array<{ target: string; url: string }> = []
    await destroyRuntimeSession(envWith(200, calls), {
      subject: "user_1",
      environmentId: "managed_1",
      sessionId: "s_cloud_1"
    })

    expect(calls).toEqual([
      { target: "s_cloud_1", url: "https://managed-session.internal/v1/destroy" }
    ])
  })

  it("still releases the account slot when configuration failed before sandbox startup", async () => {
    const calls: Array<{ target: string; url: string }> = []
    await destroyRuntimeSession(envWith(409, calls), {
      subject: "user_1",
      environmentId: "managed_1",
      sessionId: "s_cloud_partial"
    })

    expect(calls.at(-1)).toEqual({
      target: "user_1",
      url: "https://managed-account.internal/v1/sessions/unregister"
    })
  })
})
