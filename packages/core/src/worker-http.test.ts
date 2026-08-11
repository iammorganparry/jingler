import { describe, expect, it } from "vitest"
import { readBoundedJson, workerFields } from "./worker-http.js"

describe("bounded Worker HTTP", () => {
  it("rejects malformed and chunked oversized JSON", async () => {
    await expect(readBoundedJson(new Request("https://worker.test", {
      method: "POST",
      body: "{"
    }))).rejects.toThrow()
    await expect(readBoundedJson(new Request("https://worker.test", {
      method: "POST",
      body: new Blob([new Uint8Array(9), new Uint8Array(9)])
    }), 16)).rejects.toThrow("too large")
  })

  it("returns object fields only", () => {
    expect(workerFields({ ok: true })).toEqual({ ok: true })
    expect(workerFields(null)).toBeNull()
  })
})
