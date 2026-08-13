import { describe, expect, it } from "vitest"
import { sandboxIdForSession } from "./runtime-identity.js"

describe("sandboxIdForSession", () => {
  it.each(["-leading", "trailing-", "s_cloud_base64_URL-"])(
    "maps opaque session id %s to a DNS-safe label",
    async (sessionId) => {
      const sandboxId = await sandboxIdForSession(sessionId)
      expect(sandboxId).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
      expect(sandboxId.length).toBeLessThanOrEqual(63)
    }
  )

  it("is stable and does not collapse distinct opaque ids", async () => {
    await expect(sandboxIdForSession("session_a-")).resolves.toBe(
      await sandboxIdForSession("session_a-")
    )
    expect(await sandboxIdForSession("session_a-")).not.toBe(
      await sandboxIdForSession("session_a_")
    )
  })
})
