import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { ProviderId, ProviderModelId } from "@jingler/core"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RuntimeMcpServer } from "../mcp/attachment.js"
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { RunJournal } from "../journal/run-journal.js"
import {
  McpToolBridgeError,
  jinglerMcpSources,
  makeMcpToolClientFactory,
  mcpClientIdentityForModel,
  registerProgressiveMcpTools,
  registerMcpTools,
  type McpToolClient,
  type McpToolClientFactory
} from "./mcp-tools.js"
import { createMutationObserver } from "./mutation-observer.js"
import { ToolRegistry } from "./tool-registry.js"

const roots: string[] = []
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-mcp-tools-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("Pi MCP client identity", () => {
  it.each([
    ["anthropic", "anthropic/claude-sonnet", { name: "claude-code", title: "Claude Code" }],
    [undefined, "anthropic/opus", { name: "claude-code", title: "Claude Code" }],
    ["openai-codex", "openai-codex/gpt-5.6-sol", { name: "codex-mcp-client", title: "Codex" }],
    [undefined, "openai-codex/gpt-5.6-sol", { name: "codex-mcp-client", title: "Codex" }],
    ["openrouter", "openrouter/other", { name: "jingler-pi-runtime" }]
  ] as const)("maps %s / %s to its native MCP identity", (provider, model, expected) => {
    expect(mcpClientIdentityForModel(
      provider === undefined ? undefined : ProviderId.make(provider),
      ProviderModelId.make(model)
    )).toEqual(expected)
  })
})

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
  it("pins browser and configured source risks", () => {
    const named = (name: string): RuntimeMcpServer => ({ ...server, name })
    expect(
      jinglerMcpSources({
        browser: named("browser"),
        configured: [named("configured")]
      }).map(({ server: source, risk }) => [source.name, risk])
    ).toEqual([
      ["browser", "execute"],
      ["configured", "execute"]
    ])
  })
})

it("never falls back to stale MCP credentials when a live resolver returns null", async () => {
  const registry = new ToolRegistry()
  const factory = vi.fn<McpToolClientFactory>(() => Effect.die("stale endpoint used"))
  registerProgressiveMcpTools(
    registry,
    [{ server, risk: "execute", resolveServer: () => null }],
    factory
  )

  const result = await Effect.runPromise(registry.execute({
    id: "mcp_search",
    arguments: { query: "navigate" },
    role: "conversation",
    mode: "auto"
  }))
  expect(result).toMatchObject({ status: "success" })
  expect(result.value).toEqual({ matches: [{
    server: "jingler-browser",
    error: "MCP server is unavailable for this turn: jingler-browser"
  }] })
  expect(factory).not.toHaveBeenCalled()
})

it("keeps configured MCP catalogs out of the provider prompt until searched", async () => {
  const state: FakeClientState = { calls: [], closes: 0 }
  const registry = new ToolRegistry()

  registerProgressiveMcpTools(
    registry,
    [{ server, risk: "network" }],
    fakeFactory(state)
  )

  expect(registry.capabilitiesFor("conversation", "auto").map(({ id }) => id)).toEqual([
    "mcp_search",
    "mcp_call"
  ])
  expect(state.closes).toBe(0)
  expect(registry.mcpHealth()).toEqual([{ name: "jingler-browser", status: "closed" }])

  const search = await Effect.runPromise(registry.execute({
    id: "mcp_search",
    arguments: { query: "navigate" },
    role: "conversation",
    mode: "auto"
  }))
  expect(search.value).toEqual({ matches: [{
    server: "jingler-browser",
    tool: "navigate",
    description: "Open a URL in the browser",
    inputSchema: tool.inputSchema
  }] })

  const call = await Effect.runPromise(registry.execute({
    id: "mcp_call",
    arguments: {
      server: "jingler-browser",
      tool: "navigate",
      arguments: { url: "https://example.com" }
    },
    role: "conversation",
    mode: "auto"
  }))
  expect(call.status, JSON.stringify(call)).toBe("success")
  expect(state.calls).toEqual([{ name: "navigate", args: { url: "https://example.com" } }])
  expect(state.closes).toBe(3)
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
    expect(
      registry.providerInputSchemaFor("mcp__jingler-browser__navigate")
    ).toEqual(tool.inputSchema)

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

it("dials the CURRENT server config at call time when a live resolver is present", async () => {
  // Registration happens once per pi session, but a live MCP lease can rotate
  // per run. A tool bound to the registration snapshot would keep dialing the
  // first run's dead endpoint.
  const dialled: string[] = []
  const factory: McpToolClientFactory = (requested) => {
    dialled.push("url" in requested ? requested.url : "stdio")
    const client: McpToolClient = {
      listTools: () => Effect.succeed({ tools: [tool] }),
      callTool: () => Effect.succeed({ content: [{ type: "text", text: "ok" }] }),
      close: Effect.void
    }
    return Effect.succeed(client)
  }
  let currentLease: RuntimeMcpServer = { ...server, url: "http://127.0.0.1:1111/mcp" }
  const registry = new ToolRegistry()
  await Effect.runPromise(
    registerMcpTools(
      registry,
      [{
        server: currentLease,
        risk: "network",
        resolveServer: () => currentLease
      }],
      factory
    )
  )
  currentLease = { ...server, url: "http://127.0.0.1:2222/mcp" }
  const result = await Effect.runPromise(
    registry.execute({
      id: "mcp__jingler-browser__navigate",
      arguments: { url: "https://example.com" },
      role: "conversation",
      mode: "ask",
      idempotencyKey: "turn-2"
    })
  )
  expect(result.status).toBe("success")
  // Discovery dialled the registration lease; the call dialled the live one.
  expect(dialled).toEqual(["http://127.0.0.1:1111/mcp", "http://127.0.0.1:2222/mcp"])
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

it("isolates discovery failures to the unavailable MCP server", async () => {
  const unavailable = { ...server, name: "unavailable-server" }
  const state: FakeClientState = { calls: [], closes: 0 }
  const registry = new ToolRegistry()
  const factory: McpToolClientFactory = (requested) =>
    Effect.succeed({
      listTools: () =>
        requested.name === unavailable.name
          ? Effect.fail(
              new McpToolBridgeError({
                serverName: requested.name,
                message: `Could not list tools from ${requested.name}`
              })
            )
          : Effect.succeed({ tools: [tool] }),
      callTool: () => Effect.succeed({ content: [] }),
      close: Effect.sync(() => {
        state.closes += 1
      })
    })

  const report = await Effect.runPromise(
    registerMcpTools(
      registry,
      [
        { server, risk: "network" },
        { server: unavailable, risk: "network" }
      ],
      factory
    )
  )

  expect(
    registry.capabilitiesFor("conversation", "ask").map(({ id }) => id)
  ).toEqual(["mcp__jingler-browser__navigate"])
  expect(report.health).toEqual([
    { name: "jingler-browser", status: "healthy" },
    { name: "unavailable-server", status: "failed" }
  ])
  expect(report.failures).toEqual([
    expect.objectContaining({ serverName: "unavailable-server" })
  ])
  expect(state.closes).toBe(2)
})

it("connects to target-local stdio servers and supplies only resolved launch values", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url))
  const stdio: RuntimeMcpServer = {
    name: "local",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env: { JINGLER_MCP_FIXTURE: "available" }
  }
  const registry = new ToolRegistry()
  await Effect.runPromise(registerMcpTools(
    registry,
    [{ server: stdio, risk: "network" }],
    makeMcpToolClientFactory({ name: "claude-code", title: "Claude Code" })
  ))

  const result = await Effect.runPromise(registry.execute({
    id: "mcp__local__read_fixture_env",
    arguments: { prefix: "target" },
    role: "conversation",
    mode: "ask"
  }))

  const identity = await Effect.runPromise(registry.execute({
    id: "mcp__local__read_client_name",
    arguments: {},
    role: "conversation",
    mode: "ask"
  }))

  expect(result).toMatchObject({
    status: "success",
    value: { content: [{ type: "text", text: "target:available" }] }
  })
  expect(identity).toMatchObject({
    status: "success",
    value: { content: [{ type: "text", text: "claude-code:Claude Code" }] }
  })

  const codexRegistry = new ToolRegistry()
  await Effect.runPromise(registerMcpTools(
    codexRegistry,
    [{ server: stdio, risk: "network" }],
    makeMcpToolClientFactory({ name: "codex-mcp-client", title: "Codex" })
  ))
  const codexIdentity = await Effect.runPromise(codexRegistry.execute({
    id: "mcp__local__read_client_name",
    arguments: {},
    role: "conversation",
    mode: "ask"
  }))
  expect(codexIdentity).toMatchObject({
    status: "success",
    value: { content: [{ type: "text", text: "codex-mcp-client:Codex" }] }
  })
})

it("reconciles actual file changes made by mutating MCP tools", async () => {
  const root = await temporary()
  const shadowRoot = await temporary()
  execFileSync("git", ["init", "-q"], { cwd: root })
  const state: FakeClientState = { calls: [], closes: 0 }
  const output = join(root, "created-by-mcp.txt")
  const mutatingFactory: McpToolClientFactory = () => Effect.succeed({
    listTools: () => Effect.succeed({ tools: [tool] }),
    callTool: () => Effect.promise(async () => {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, "created")
      return { content: [{ type: "text", text: "written" }] }
    }),
    close: Effect.sync(() => { state.closes += 1 })
  })
  const registry = new ToolRegistry({
    observer: createMutationObserver({
      cwd: root,
      runId: "run-mcp",
      sessionId: "session-mcp",
      chatId: "chat-mcp",
      tracker: new FileChangeTracker({
        artifactDir: join(root, ".artifacts"),
        sessionId: "session-mcp",
        shadowIndexRoot: shadowRoot
      }),
      journal: new RunJournal({ file: join(root, ".journal", "run-mcp.json") })
    })
  })
  await Effect.runPromise(registerMcpTools(
    registry,
    [{ server, risk: "execute" }],
    mutatingFactory
  ))

  const result = await Effect.runPromise(registry.execute({
    id: "mcp__jingler-browser__navigate",
    arguments: { url: "https://example.com" },
    role: "conversation",
    mode: "ask",
    callId: "mcp-call",
    idempotencyKey: "mcp-call"
  }))

  expect(result.status, JSON.stringify(result)).toBe("success")
  expect(result.fileChanges?.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: "A", path: "created-by-mcp.txt" })
  ]))
  expect(state.closes).toBe(2)
})

it("rejects sanitized duplicate MCP tool ids deterministically", async () => {
  const first = { ...server, name: "jingler.browser" }
  const duplicate = { ...server, name: "jingler/browser" }
  const registry = new ToolRegistry()
  const state: FakeClientState = { calls: [], closes: 0 }
  const result = await Effect.runPromise(Effect.either(registerMcpTools(
    registry,
    [
      { server: first, risk: "network" },
      { server: duplicate, risk: "network" }
    ],
    () => Effect.succeed({
      listTools: () => Effect.succeed({ tools: [tool] }),
      callTool: () => Effect.succeed({ content: [] }),
      close: Effect.sync(() => {
        state.closes += 1
      })
    })
  )))

  expect(result._tag).toBe("Left")
  expect(registry.capabilitiesFor("conversation", "ask")).toEqual([])
})
