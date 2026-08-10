import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { RuntimeMcpServer } from "../mcp/attachment.js"
import {
  McpToolBridgeError,
  jinglerMcpSources,
  registerMcpTools,
  type McpToolClient,
  type McpToolClientFactory
} from "./mcp-tools.js"
import { ToolRegistry } from "./tool-registry.js"

const server: RuntimeMcpServer = {
  name: "jingler-browser",
  url: "http://127.0.0.1:1234/mcp",
  headers: { Authorization: "Bearer test" }
}

const tool: Tool = {
  name: "navigate",
  description: "Open a URL in the browser",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false
  },
  annotations: { idempotentHint: true }
}

interface FakeClientState {
  readonly calls: Array<{
    readonly name: string
    readonly args: Readonly<Record<string, unknown>>
  }>
  closes: number
}

const fakeFactory = (
  state: FakeClientState,
  result: CallToolResult = {
    content: [{ type: "text", text: "opened" }]
  }
): McpToolClientFactory =>
  (requested) => {
    if (requested !== server) {
      return Effect.fail(
        new McpToolBridgeError({
          serverName: requested.name,
          message: "unexpected server"
        })
      )
    }
    const client: McpToolClient = {
      listTools: () => Effect.succeed({ tools: [tool] }),
      callTool: (name, args) =>
        Effect.sync(() => {
          state.calls.push({ name, args })
          return result
        }),
      close: Effect.sync(() => {
        state.closes += 1
      })
    }
    return Effect.succeed(client)
  }

describe("MCP source policy", () => {
  it("pins browser, memory, connector, and imported source risks", () => {
    const named = (name: string): RuntimeMcpServer => ({ ...server, name })
    expect(
      jinglerMcpSources({
        browser: named("browser"),
        memory: named("memory"),
        openConnector: named("open-connector"),
        imported: [named("imported")]
      }).map(({ server: source, risk }) => [source.name, risk])
    ).toEqual([
      ["browser", "execute"],
      ["memory", "network"],
      ["open-connector", "execute"],
      ["imported", "execute"]
    ])
  })
})

it("discovers, namespaces, validates, invokes, and closes stateless MCP clients", async () => {
    const state: FakeClientState = { calls: [], closes: 0 }
    const registry = new ToolRegistry()
    await Effect.runPromise(
      registerMcpTools(
        registry,
        [{ server, risk: "network" }],
        fakeFactory(state)
      )
    )

    expect(
      registry.capabilitiesFor("conversation", "ask").map(({ id }) => id)
    ).toEqual(["mcp__jingler-browser__navigate"])

    const invalid = await Effect.runPromise(
      registry.execute({
        id: "mcp__jingler-browser__navigate",
        arguments: {},
        role: "conversation",
        mode: "ask",
        idempotencyKey: "invalid"
      })
    )
    expect(invalid.error?.code).toBe("invalid-input")
    expect(state.calls).toEqual([])

    const valid = await Effect.runPromise(
      registry.execute({
        id: "mcp__jingler-browser__navigate",
        arguments: { url: "https://example.com" },
        role: "conversation",
        mode: "ask",
        idempotencyKey: "call-1"
      })
    )
    expect(valid.status).toBe("success")
    expect(state.calls).toEqual([
      { name: "navigate", args: { url: "https://example.com" } }
    ])
    expect(state.closes).toBe(2)
})

it("never trusts MCP annotations to lower the configured source risk", async () => {
    const state: FakeClientState = { calls: [], closes: 0 }
    const registry = new ToolRegistry()
    await Effect.runPromise(
      registerMcpTools(
        registry,
        [{ server, risk: "execute" }],
        fakeFactory(state)
      )
    )

    expect(registry.riskFor("mcp__jingler-browser__navigate")).toBe("execute")
})

it("turns MCP error results into structured tool failures", async () => {
    const state: FakeClientState = { calls: [], closes: 0 }
    const registry = new ToolRegistry()
    await Effect.runPromise(
      registerMcpTools(
        registry,
        [{ server, risk: "network" }],
        fakeFactory(state, {
          content: [{ type: "text", text: "remote failure" }],
          isError: true
        })
      )
    )

    const result = await Effect.runPromise(
      registry.execute({
        id: "mcp__jingler-browser__navigate",
        arguments: { url: "https://example.com" },
        role: "conversation",
        mode: "ask",
        idempotencyKey: "call-2"
      })
    )
  expect(result.error).toMatchObject({
    code: "execution-failed",
    message: "remote failure"
  })
  expect(state.closes).toBe(2)
})
