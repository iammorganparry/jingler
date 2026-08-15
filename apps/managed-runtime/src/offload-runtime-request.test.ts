import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  OffloadRuntimePrimeRequest,
  OffloadRuntimeSandboxDestroyRequest
} from "./offload-runtime-request.js"

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema)(value, { onExcessProperty: "error" })

describe("offload server-to-runtime request versions", () => {
  it("accepts the exact versioned prime and destroy payloads", () => {
    expect(decode(OffloadRuntimePrimeRequest, {
      version: 1,
      subject: "user_one",
      sessionId: "session_aaaaaaaaaaaaaaaa",
      repositorySlug: "jingler/example",
      headSha: "a".repeat(40)
    })._tag).toBe("Right")
    expect(decode(OffloadRuntimeSandboxDestroyRequest, {
      version: 1,
      subject: "user_one",
      sessionId: "session_aaaaaaaaaaaaaaaa"
    })._tag).toBe("Right")
  })

  it("rejects missing, unsupported, and excess protocol fields", () => {
    for (const value of [
      { subject: "user_one", sessionId: "session_aaaaaaaaaaaaaaaa" },
      { version: 2, subject: "user_one", sessionId: "session_aaaaaaaaaaaaaaaa" },
      { version: 1, subject: "user_one", sessionId: "session_aaaaaaaaaaaaaaaa", extra: true }
    ]) {
      expect(decode(OffloadRuntimeSandboxDestroyRequest, value)._tag).toBe("Left")
    }
  })
})
