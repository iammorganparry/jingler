import { gzipSync } from "node:zlib"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ protocol: { handle: vi.fn() } }))

const { forwardTelemetry, tokensIn } = await import("./telemetry-proxy.js")

const KEY = "phc_ours"
const config = (fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }))) =>
  ({ key: KEY, host: "https://eu.i.posthog.com", fetch: fetchImpl as unknown as typeof fetch })

const post = (path: string, body: BodyInit, contentType = "application/json") =>
  new Request(`jingler-telemetry://posthog${path}`, { method: "POST", body, headers: { "content-type": contentType } })

describe("tokensIn", () => {
  it("collects top-level and per-event tokens from batches", () => {
    expect(tokensIn({ api_key: "a", batch: [{ properties: { token: "b" } }, { properties: {} }] })).toEqual(["a", "b"])
    expect(tokensIn([{ properties: { token: "c" } }])).toEqual(["c"])
  })
})

describe("forwardTelemetry", () => {
  it("forwards our own events to our host", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }))
    const res = await forwardTelemetry(post("/e/?ip=0", JSON.stringify({ event: "x", properties: { token: KEY } })), config(f))
    expect(res.status).toBe(200)
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://eu.i.posthog.com/e/?ip=0")
  })

  it("decodes gzip bodies before checking tokens", async () => {
    const body = gzipSync(JSON.stringify([{ event: "x", properties: { token: KEY } }]))
    const res = await forwardTelemetry(post("/batch/?compression=gzip-js", body, "text/plain"), config())
    expect(res.status).toBe(200)
  })

  it("refuses a batch smuggling in a foreign project token", async () => {
    const f = vi.fn()
    const body = JSON.stringify([{ properties: { token: KEY } }, { properties: { token: "phc_plugin" } }])
    const res = await forwardTelemetry(post("/batch/", body), config(f as never))
    expect(res.status).toBe(403)
    expect(f).not.toHaveBeenCalled()
  })

  it("refuses bodies with no token and GETs for another project", async () => {
    expect((await forwardTelemetry(post("/e/", JSON.stringify({ event: "x" })), config())).status).toBe(403)
    const get = new Request("jingler-telemetry://posthog/array/phc_plugin/config")
    expect((await forwardTelemetry(get, config())).status).toBe(403)
  })

  it("does nothing without a build-time key", async () => {
    const res = await forwardTelemetry(post("/e/", "{}"), { ...config(), key: undefined })
    expect(res.status).toBe(404)
  })
})
