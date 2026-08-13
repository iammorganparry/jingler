import { describe, expect, it } from "vitest"

import { claimsManagedSessionSlot, decodeManagedGrantRequest } from "./grant-request.js"

describe("decodeManagedGrantRequest", () => {
  it("accepts cancellation grants without a usage reservation", () => {
    expect(
      decodeManagedGrantRequest({
        version: 1,
        subject: "user_one",
        environmentId: "managed_one",
        sessionId: "session_one",
        reservationId: null,
        actions: ["session.cancel"],
        environmentGeneration: 1,
        connectionId: "connection_one",
        providerId: "openai",
        modelId: "openai/gpt-5"
      })
    ).toEqual({
      version: 1,
      subject: "user_one",
      environmentId: "managed_one",
      sessionId: "session_one",
      reservationId: null,
      actions: ["session.cancel"],
      environmentGeneration: 1,
      connectionId: "connection_one",
      providerId: "openai",
      modelId: "openai/gpt-5"
    })
  })

  it("claims concurrency only for execution grants", () => {
    expect(claimsManagedSessionSlot(["session.start"])).toBe(true)
    expect(claimsManagedSessionSlot(["session.input"])).toBe(true)
    expect(claimsManagedSessionSlot(["session.observe"])).toBe(false)
    expect(claimsManagedSessionSlot(["session.cancel"])).toBe(false)
  })
})
