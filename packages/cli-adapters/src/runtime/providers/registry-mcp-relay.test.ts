import { Server } from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, stat } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Schema } from "effect"
import type { StreamEvent } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity } from "../agent/agent-runtime.js"
import { createPiTools } from "../agent/pi-tool-bridge.js"
import { ToolRegistry, type ToolDefinition } from "../tools/tool-registry.js"
import { startRegistryMcpRelay } from "./registry-mcp-relay.js"

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
const connect = async (relay: Awaited<ReturnType<typeof startRegistryMcpRelay>>) => {
  const serialized = await readFile(relay.mcpConfigPath, "utf8")
  const config = JSON.parse(serialized)
  const { url } = config.mcpServers.jingler
  const headers = { Authorization: `Bearer ${relay.environment.JINGLER_TOOL_RELAY_TOKEN}` }
  const client = new Client({ name: "test", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  return { client, url: url as string, headers, serialized }
}

describe("native Claude registry MCP relay", () => {
  it("returns two real results and concurrent results using PI's exact active capabilities", async () => {
    const registry = new ToolRegistry()
    registry.register(definition())
    registry.register(definition({ id: "hidden", roles: ["review"] }))
    const relay = await startRegistryMcpRelay({ registry, spec, context })
    const { client, serialized } = await connect(relay)
    try {
      expect((await stat(relay.mcpConfigPath)).mode & 0o777).toBe(0o600)
      expect(serialized).not.toContain(relay.environment.JINGLER_TOOL_RELAY_TOKEN)
      expect(serialized).toContain("${JINGLER_TOOL_RELAY_TOKEN}")
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

  it("publishes command targets and ordered output with the same ID as the final result", async () => {
    const events: StreamEvent[] = []
    const registry = new ToolRegistry({ observer: {
      started: () => Effect.succeed({ cwd: "/workspace", tree: "before" }),
      settled: (request) => Effect.succeed({
        id: request.callId!, callId: request.callId!, changes: [], totals: { added: 0, removed: 0 },
        authoritative: true, reconciledAt: "2026-09-25T00:00:00.000Z"
      })
    } })
    registry.register({
      ...definition(), id: "command_execute", input: Schema.Struct({ command: Schema.String }),
      risk: "execute", outputBudget: 1000,
      execute: async ({ command }, { progress }) => {
        progress({ message: "hello", completed: 1, total: 1 })
        const { stdout, stderr } = await promisify(execFile)(process.execPath, ["-e", "console.log('hello')"])
        return { command, exitCode: 0, stdout, stderr }
      }
    })
    const relay = await startRegistryMcpRelay({ registry, spec, context: {
      ...context, publishEvent: (event) => Effect.promise(async () => {
        await Promise.resolve()
        events.push(event)
      })
    } })
    const { client } = await connect(relay)
    try {
      expect(await client.callTool({ name: "command_execute", arguments: { command: "echo hello" } }))
        .toMatchObject({ content: [{ type: "text", text: "hello" }], isError: false })
      const id = events[0]?._tag === "ToolStart" ? events[0].id : "missing"
      expect(events).toEqual([
        { _tag: "ToolStart", id, name: "command_execute", target: "echo hello" },
        { _tag: "ToolDelta", id, output: "hello" },
        expect.objectContaining({ _tag: "ToolEnd", id, status: "success", output: "hello" })
      ])
    } finally { await client.close(); await relay.close() }
  })

  it("handles rejected progress immediately while execution is pending", async () => {
    const events: StreamEvent[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let published!: () => void
    const rejected = new Promise<void>((resolve) => { published = resolve })
    const registry = new ToolRegistry()
    registry.register(definition({ execute: async (_input, { progress }) => {
      progress({ message: "pending", completed: 0, total: 1 })
      await held
      return "finished"
    } }))
    const relay = await startRegistryMcpRelay({ registry, spec, context: {
      ...context, publishEvent: (event) => Effect.sync(() => {
        events.push(event)
        if (event._tag === "ToolDelta") { published(); throw new Error("publication failed") }
      })
    } })
    const { client } = await connect(relay)
    try {
      const pending = client.callTool({ name: "echo", arguments: { value: "x" } })
      await rejected
      // Cross an event-loop boundary while execution is held: unhandled rejections fail Vitest.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(events.map(({ _tag }) => _tag)).toEqual(["ToolStart", "ToolDelta"])
      release()
      expect(await pending).toMatchObject({ isError: true })
      expect(events.map(({ _tag }) => _tag)).toEqual(["ToolStart", "ToolDelta", "ToolEnd"])
      expect(events.at(-1)).toMatchObject({ status: "error" })
    } finally { release(); await client.close(); await relay.close() }
  })

  it("drains pending progress before ToolEnd when registry execution throws", async () => {
    const events: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const publishing = new Promise<void>((resolve) => { started = resolve })
    const registry = new ToolRegistry()
    registry.register(definition())
    vi.spyOn(registry, "execute").mockImplementation((request) => Effect.sync(() => {
      request.progress?.({ message: "pending", completed: 0, total: 1 })
    }).pipe(Effect.zipRight(Effect.die("registry failed"))))
    const relay = await startRegistryMcpRelay({ registry, spec, context: {
      ...context, publishEvent: (event) => Effect.promise(async () => {
        if (event._tag === "ToolDelta") { started(); await held }
        events.push(event._tag)
      })
    } })
    const { client } = await connect(relay)
    try {
      const pending = client.callTool({ name: "echo", arguments: { value: "x" } })
      await publishing
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(events).toEqual(["ToolStart"])
      release()
      expect(await pending).toMatchObject({ isError: true })
      expect(events).toEqual(["ToolStart", "ToolDelta", "ToolEnd"])
    } finally { release(); await client.close(); await relay.close() }
  })

  it("denies permission, unknown and inactive tools, validates input and bounds output", async () => {
    const execute = vi.fn(async () => "never")
    const registry = new ToolRegistry()
    registry.register(definition())
    registry.register(definition({ id: "network", risk: "network", execute }))
    registry.register(definition({ id: "hidden", roles: ["review"], execute }))
    const relay = await startRegistryMcpRelay({ registry, spec, context: { ...context, canUseTool: () => Effect.succeed("deny") } })
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

  it("settles the visible tool when permission handling fails without exposing the exception", async () => {
    const events: StreamEvent[] = []
    const registry = new ToolRegistry()
    registry.register(definition({ risk: "network" }))
    const relay = await startRegistryMcpRelay({ registry, spec, context: {
      ...context,
      canUseTool: () => Effect.die(new Error("private credential detail")),
      publishEvent: (event) => Effect.sync(() => { events.push(event) })
    } })
    const { client } = await connect(relay)
    try {
      const result = await client.callTool({ name: "echo", arguments: { value: "x" } })
      expect(result).toMatchObject({ isError: true })
      expect(JSON.stringify(result)).not.toContain("private credential")
      expect(events.map(({ _tag }) => _tag)).toEqual(["ToolStart", "ToolEnd"])
      expect(events[1]).toMatchObject({ status: "error" })
    } finally { await client.close(); await relay.close() }
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
    const relay = await startRegistryMcpRelay({ registry, spec, context })
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
    const relay = await startRegistryMcpRelay({ registry, spec, context: {
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

it("binds the actual MCP listener exclusively to IPv4 loopback", async () => {
  const listen = vi.spyOn(Server.prototype, "listen")
  try {
    const relay = await startRegistryMcpRelay({ registry: new ToolRegistry(), spec, context })
    try {
      expect(listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function))
      const server = listen.mock.instances[0]!
      expect(server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" })
    } finally { await relay.close() }
  } finally { listen.mockRestore() }
})
