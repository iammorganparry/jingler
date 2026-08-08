import { describe, expect, it } from "vitest"
import { app } from "./app.js"

describe("device routes in the shipped server app", () => {
  it("mounts device control under /api/devices", async () => {
    const apiResponse = await app.request("/api/devices")
    const legacyResponse = await app.request("/devices")

    // The unit-test environment intentionally leaves the relay disabled, so a
    // mounted route reports service unavailable. A missing route reports 404.
    expect(apiResponse.status).toBe(503)
    expect(legacyResponse.status).toBe(404)
  })
})
