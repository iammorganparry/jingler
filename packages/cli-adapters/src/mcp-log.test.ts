import { fileURLToPath } from "node:url"
import { PassThrough } from "node:stream"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { ParsedMcpServer } from "./runtime/mcp/attachment.js"
import { captureMcpStderr, MAX_LOG_LINES, mcpLogTail } from "./mcp-log.js"
import { probeServer } from "./mcp-probe.js"

const FAKE_SERVER = fileURLToPath(new URL("./mcp-fixtures/fake-mcp-server.mjs", import.meta.url))

const capture = (name: string, text: string) => {
  const stream = new PassThrough()
  captureMcpStderr(name, stream)
  stream.end(text)
  return new Promise<void>((resolve) => stream.on("end", resolve).resume())
}

describe("mcpLogTail", () => {
  it("returns empty for an unknown server", () => {
    expect(mcpLogTail("never-probed")).toStrictEqual([])
  })

  it("returns the last N lines, keeping a trailing partial line", async () => {
    await capture("tail", "a\nb\r\nc\nd")
    expect(mcpLogTail("tail", 2)).toStrictEqual(["c", "d"])
    expect(mcpLogTail("tail")).toStrictEqual(["a", "b", "c", "d"])
  })

  it("caps the ring and the requested count at MAX_LOG_LINES", async () => {
    await capture("flood", Array.from({ length: MAX_LOG_LINES + 50 }, (_, i) => `l${i}`).join("\n"))
    const all = mcpLogTail("flood", 10_000)
    expect(all).toHaveLength(MAX_LOG_LINES)
    expect(all.at(-1)).toBe(`l${MAX_LOG_LINES + 49}`)
    expect(all[0]).toBe("l50")
  })

  it("a new capture replaces the previous tail", async () => {
    await capture("replace", "old\n")
    await capture("replace", "new\n")
    expect(mcpLogTail("replace")).toStrictEqual(["new"])
  })

  it("serves a failing stdio server's stderr after a probe", async () => {
    const entry: ParsedMcpServer = {
      server: {
        name: "crashing", displayName: "crashing", iconUrl: null, authKind: "none", authState: "not-required",
        transport: "stdio", scope: "user", target: "node crashing", envKeys: [], headerKeys: [], enabled: true
      },
      launch: { transport: "stdio", command: process.execPath, args: [FAKE_SERVER, "stderr-crash"], env: {}, headers: {} }
    }
    const status = await Effect.runPromise(probeServer(entry, null, () => "2026-07-18T00:00:00.000Z"))
    expect(status.state).toBe("failed")
    expect(mcpLogTail("crashing")).toStrictEqual(["booting", "missing API_KEY", "fatal: no cred"])
  })
})
