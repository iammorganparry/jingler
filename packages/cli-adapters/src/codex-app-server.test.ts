import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  codexContextUsageFromMessage,
  withCodexAppServer
} from "./codex-app-server.js"

const fakeAppServers: Array<string> = []

const fakeAppServer = (requestBody: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "jingler-codex-app-server-"))
  fakeAppServers.push(directory)
  const executable = join(directory, "codex")
  writeFileSync(
    executable,
    `#!/usr/bin/env node
let buffer = ""
let initialized = false
let requestCount = 0
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {} })
      continue
    }
    if (message.method === "initialized") {
      initialized = true
      continue
    }
    if (!initialized) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32002, message: "not initialized" }
      })
      continue
    }
    requestCount += 1
    ${requestBody}
  }
})
`
  )
  chmodSync(executable, 0o755)
  return executable
}

afterEach(() => {
  for (const directory of fakeAppServers.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("withCodexAppServer", () => {
  it("acknowledges initialization before making multiple requests in one process", async () => {
    const executable = fakeAppServer(`
send({
  jsonrpc: "2.0",
  id: message.id,
  result: { method: message.method, requestCount }
})`)

    await expect(
      withCodexAppServer(
        executable,
        async (session) => [
          await session.request("probe/one", {}),
          await session.request("probe/two", {})
        ],
        { timeoutMs: 2_000 }
      )
    ).resolves.toStrictEqual([
      { method: "probe/one", requestCount: 1 },
      { method: "probe/two", requestCount: 2 }
    ])
  })

  it("resolves null when the process exits during a request", async () => {
    const executable = fakeAppServer("process.exit(0)")

    await expect(
      withCodexAppServer(
        executable,
        (session) => session.request("probe/exit", {}),
        { timeoutMs: 2_000 }
      )
    ).resolves.toBeNull()
  })

  it("times out a request without hanging the caller", async () => {
    const executable = fakeAppServer("// Deliberately never reply.")
    const started = Date.now()

    await expect(
      withCodexAppServer(
        executable,
        (session) => session.request("probe/hang", {}),
        { timeoutMs: 500 }
      )
    ).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("codexContextUsageFromMessage", () => {
  it("reads resident context rather than cumulative spend", () => {
    expect(
      codexContextUsageFromMessage(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "019f8e18-e349-70f3-95ce-ca343fb3d016",
            tokenUsage: {
              total: {
                inputTokens: 2_961_789,
                cachedInputTokens: 2_758_656,
                outputTokens: 17_495,
                reasoningOutputTokens: 10_295,
                totalTokens: 2_979_284
              },
              last: {
                inputTokens: 190_098,
                cachedInputTokens: 186_112,
                outputTokens: 3_398,
                reasoningOutputTokens: 1_174,
                totalTokens: 193_496
              },
              modelContextWindow: 258_400
            }
          }
        },
        "019f8e18-e349-70f3-95ce-ca343fb3d016"
      )
    ).toStrictEqual({ tokens: 193_496, window: 258_400 })
  })

  it("ignores usage for a different thread", () => {
    expect(
      codexContextUsageFromMessage(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "other",
            tokenUsage: {
              last: { totalTokens: 12_000 },
              modelContextWindow: 258_400
            }
          }
        },
        "wanted"
      )
    ).toBeNull()
  })

  it.each([
    null,
    {},
    { method: "turn/completed", params: {} },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "wanted",
        tokenUsage: { last: { totalTokens: Number.NaN }, modelContextWindow: 258_400 }
      }
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "wanted",
        tokenUsage: { last: { totalTokens: 1_000 }, modelContextWindow: 0 }
      }
    }
  ])("degrades malformed notifications to null", (message) => {
    expect(codexContextUsageFromMessage(message, "wanted")).toBeNull()
  })
})
