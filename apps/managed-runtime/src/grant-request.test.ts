import { describe, expect, it } from "vitest"

import { decodeManagedGrantRequest } from "./grant-request.js"

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
        environmentGeneration: 1
      })
    ).toEqual({
      subject: "user_one",
      environmentId: "managed_one",
      sessionId: "session_one",
      reservationId: null,
      actions: ["session.cancel"],
      environmentGeneration: 1
    })
  })
})
