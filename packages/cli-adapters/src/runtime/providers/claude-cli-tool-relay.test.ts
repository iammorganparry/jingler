import { readFile, stat } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity } from "../agent/agent-runtime.js"
import { createPiTools } from "../agent/pi-tool-bridge.js"
import { ToolRegistry, type ToolDefinition } from "../tools/tool-registry.js"
import { startClaudeCliToolRelay } from "./claude-cli-tool-relay.js"

const spec = { role: "conversation", mode: "ask" } as const
const context = {
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("allow" as const),
  askQuestion: () => Effect.succeed([])
}
const definition = (overrides: Partial<ToolDefinition<{ value: string }>> = {}): ToolDefinition<{ value: string }> => ({
  id: "echo", version: "1", description: "Echo", input: Schema.Struct({ value: Schema.String }),
  roles: ["conversation"], modes: ["ask"], risk: "read", timeoutMs: 1000,
  outputBudget: 100, cancellable: true, idempotency: "safe",
  execute: async ({ value }) => ({ actual: value }), ...overrides
})
const connect = async (relay: Awaited<ReturnType<typeof startClaudeCliToolRelay>>) => {
  const serialized = await readFile(relay.mcpConfigPath, "utf8")
  const config = JSON.parse(serialized)
  const { url } = config.mcpServers.jingler
  const headers = { Authorization: `Bearer ${relay.environment.JINGLER_CLAUDE_MCP_TOKEN}` }
  const client = new Client({ name: "test", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  return { client, url: url as string, headers, serialized }
}

describe("native Claude registry MCP relay", () => {
  it("returns two real results and concurrent results using PI's exact active capabilities", async () => {
    const registry = new ToolRegistry()
    registry.register(definition())
    registry.register(definition({ id: "hidden", roles: ["review"] }))
    const relay = await startClaudeCliToolRelay({ registry, spec, context })
    const { client, serialized } = await connect(relay)
    try {
      expect((await stat(relay.mcpConfigPath)).mode & 0o777).toBe(0o600)
      expect(serialized).not.toContain(relay.environment.JINGLER_CLAUDE_MCP_TOKEN)
      expect(serialized).toContain("${JINGLER_CLAUDE_MCP_TOKEN}")
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(createPiTools(registry, spec, context).map(({ name }) => name))
      for (const value of ["first", "second"]) {
        expect(await client.callTool({ name: "echo", arguments: { value } })).toMatchObject({
          content: [{ type: "text", text: JSON.stringify({ actual: value }) }], isError: false
        })
      }
      const values = ["a", "b", "c"]
      const results = await Promise.all(values.map((value) => client.callTool({ name: "echo", arguments: { value } })))
      expect(results.map((result) => result.content)).toEqual(values.map((actual) => [{ type: "text", text: JSON.stringify({ actual }) }]))
    } finally { await client.close(); await relay.close() }
    await expect(stat(relay.mcpConfigPath)).rejects.toThrow()
    await relay.close()
  })

  it("denies permission, unknown and inactive tools, validates input and bounds output", async () => {
    const execute = vi.fn(async () => "never")
    const registry = new ToolRegistry()
    registry.register(definition())
    registry.register(definition({ id: "network", risk: "network", execute }))
    registry.register(definition({ id: "hidden", roles: ["review"], execute }))
    const relay = await startClaudeCliToolRelay({ registry, spec, context: { ...context, canUseTool: () => Effect.succeed("deny") } })
    const { client, url, headers } = await connect(relay)
    try {
      for (const [name, args, code] of [
        ["network", { value: "x" }, "forbidden"],
        ["hidden", { value: "x" }, "forbidden"],
        ["unknown", {}, "forbidden"],
        ["echo", { value: 1 }, "invalid-input"],
        ["echo", { value: "x".repeat(200) }, "artifact-required"]
      ] as const) {
        expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining(code) }] })
      }
      expect(execute).not.toHaveBeenCalled()
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403)
      const malformed = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{" })
      expect(malformed.status).toBe(400)
    } finally { await client.close(); await relay.close() }
    await expect(fetch(url)).rejects.toThrow()
  })

  it("aborts an in-flight call and closes its sockets/config on close", async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let aborted = false
    const registry = new ToolRegistry()
    registry.register(definition({ execute: async (_input, { signal }) => {
      started()
      return new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(null) }, { once: true }))
    } }))
    const relay = await startClaudeCliToolRelay({ registry, spec, context })
    const { client } = await connect(relay)
    const pending = client.callTool({ name: "echo", arguments: { value: "x" } }).catch(() => null)
    await ready
    await relay.close()
    await pending
    await client.close()
    expect(aborted).toBe(true)
    await expect(stat(relay.mcpConfigPath)).rejects.toThrow()
  })
  it("serializes mutation observations and journals permission denials", async () => {
    const order: string[] = []
    const denied = vi.fn(() => Effect.void)
    const registry = new ToolRegistry({ observer: {
      started: (request) => Effect.sync(() => {
        order.push(`start:${request.callId}`)
        return { cwd: "/workspace", tree: "before" }
      }),
      settled: (request) => Effect.sync(() => {
        order.push(`end:${request.callId}`)
        return { id: request.callId!, callId: request.callId!, changes: [], totals: { added: 0, removed: 0 }, authoritative: true, reconciledAt: "2026-09-25T00:00:00.000Z" }
      }),
      denied
    } })
    registry.register(definition({ risk: "mutate", idempotency: "keyed" }))
    let allow = true
    const relay = await startClaudeCliToolRelay({ registry, spec, context: {
      ...context, canUseTool: () => Effect.succeed(allow ? "allow" : "deny")
    } })
    const { client } = await connect(relay)
    try {
      await Promise.all(["one", "two"].map((value) => client.callTool({ name: "echo", arguments: { value } })))
      expect(order).toHaveLength(4)
      expect(order[0]!.replace("start:", "")).toBe(order[1]!.replace("end:", ""))
      expect(order[2]!.replace("start:", "")).toBe(order[3]!.replace("end:", ""))
      expect(order[0]).not.toBe(order[2])
      allow = false
      expect(await client.callTool({ name: "echo", arguments: { value: "denied" } })).toMatchObject({ isError: true })
      expect(denied).toHaveBeenCalledOnce()
      expect(order).toHaveLength(4)
    } finally { await client.close(); await relay.close() }
  })

})
