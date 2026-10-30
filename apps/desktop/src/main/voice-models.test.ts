import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ChecksumMismatch, downloadVerified } from "./voice-models.js"

const body = Buffer.from("fake whisper model bytes")
const sha256 = createHash("sha256").update(body).digest("hex")
let server: Server
let url: string
let dir: string

beforeAll(async () => {
  server = createServer((_, res) => res.end(body))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m.bin`
  dir = await mkdtemp(join(tmpdir(), "voice-models-"))
})
afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

describe("downloadVerified", () => {
  it("renames the .part file into place when the SHA-256 matches", async () => {
    const dest = join(dir, "ok.bin")
    let received = 0
    await downloadVerified({ url, dest, sha256, onProgress: (n) => (received = n) })
    expect(await readFile(dest)).toEqual(body)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(received).toBe(body.length)
  })

  it("deletes the .part file and throws on a mismatch", async () => {
    const dest = join(dir, "bad.bin")
    await expect(downloadVerified({ url, dest, sha256: "0".repeat(64), onProgress: () => {} })).rejects.toBeInstanceOf(ChecksumMismatch)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })

  it("downloads through the injected fetch", async () => {
    const dest = join(dir, "injected.bin")
    const seen: string[] = []
    const fetchVia = (target: string) => {
      seen.push(target)
      return Promise.resolve(new Response(body))
    }
    await downloadVerified({ url: "https://example.invalid/m.bin", dest, sha256, onProgress: () => {}, fetch: fetchVia })
    expect(seen).toEqual(["https://example.invalid/m.bin"])
    expect(await readFile(dest)).toEqual(body)
  })

  it("surfaces the network cause instead of a bare 'fetch failed'", async () => {
    const dest = join(dir, "offline.bin")
    const failing = () => Promise.reject(new TypeError("fetch failed", { cause: new Error("unable to get local issuer certificate") }))
    await expect(downloadVerified({ url, dest, sha256, onProgress: () => {}, fetch: failing })).rejects.toThrow(
      "Download failed: unable to get local issuer certificate"
    )
    expect(existsSync(`${dest}.part`)).toBe(false)
  })
})
