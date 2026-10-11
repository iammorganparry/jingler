import { NotificationPermission } from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

describe("NotificationPermission over the wire", () => {
  it.each(["granted", "denied", "unsupported", "unknown"] as const)("decodes %s", (state) => {
    const encoded = Schema.encodeSync(NotificationPermission)(state)
    expect(Schema.decodeUnknownSync(NotificationPermission)(JSON.parse(JSON.stringify(encoded)))).toBe(state)
  })

  it("rejects an unknown state", () => {
    expect(() => Schema.decodeUnknownSync(NotificationPermission)("maybe")).toThrow()
  })
})
