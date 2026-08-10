import { describe, expect, it } from "vitest"
import { openCredential, sealCredential } from "./credential-envelope.js"

const secret = "auth-state-encryption-key-with-at-least-32-bytes"

describe("credential envelope", () => {
  it("round-trips provider authorization without storing plaintext", async () => {
    const envelope = await sealCredential("Bearer provider-secret", secret)
    expect(envelope).toMatch(/^v1\./u)
    expect(envelope).not.toContain("provider-secret")
    await expect(openCredential(envelope, secret)).resolves.toBe("Bearer provider-secret")
  })

  it("rejects a credential encrypted by another authority", async () => {
    const envelope = await sealCredential("Bearer provider-secret", secret)
    await expect(
      openCredential(envelope, "different-encryption-key-with-at-least-32-bytes")
    ).rejects.toThrow()
  })
})
