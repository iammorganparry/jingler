import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { RuntimeDiagnosticMcpHealth } from "@jingler/core"
import { Data, Effect, Schema } from "effect"
import type { RuntimeMcpServer } from "../mcp/attachment.js"
import { ToolError, type ToolRegistry, type ToolRisk } from "./tool-registry.js"

const TOOL_PAGE_LIMIT = 32
const TOOL_TIMEOUT_MS = 60_000
const TOOL_OUTPUT_BUDGET = 16_000
const roles = [
  "conversation",
  "plan",
  "plan-execution",
  "review",
  "context-digest",
  "background"
] as const
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const
const argumentsSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const validator = new AjvJsonSchemaValidator()

export class McpToolBridgeError extends Data.TaggedError("McpToolBridgeError")<{
  readonly serverName: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface McpToolClient {
  readonly listTools: (
    cursor?: string
  ) => Effect.Effect<
    { readonly tools: ReadonlyArray<Tool>; readonly nextCursor?: string },
    McpToolBridgeError
  >
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ) => Effect.Effect<CallToolResult, McpToolBridgeError>
  readonly close: Effect.Effect<void>
}

export type McpToolClientFactory = (
  server: RuntimeMcpServer
) => Effect.Effect<McpToolClient, McpToolBridgeError>

export interface McpToolSource {
  readonly server: RuntimeMcpServer
  /** Explicit source policy; untrusted MCP annotations never lower this risk. */
  readonly risk: ToolRisk
  /**
   * The CURRENT connection config for this server, resolved at each call.
   *
   * Registration happens once per pi session, but some attachments are
   * per-RUN: the browser MCP lease is a fresh loopback port + bearer whose
   * listener closes with the run's scope. A tool bound to the registration
   * snapshot therefore dials a dead endpoint on every turn after the first.
   * Absent (or returning null) falls back to the registration-time `server`.
   */
  readonly resolveServer?: () => RuntimeMcpServer | null
}

export interface McpToolRegistrationReport {
  readonly health: ReadonlyArray<RuntimeDiagnosticMcpHealth>
  readonly failures: ReadonlyArray<McpToolBridgeError>
}

interface McpDiscovery {
  readonly source: McpToolSource
  readonly tools: ReadonlyArray<Tool> | null
  readonly error: McpToolBridgeError | null
}

export interface JinglerMcpAttachments {
  readonly browser?: RuntimeMcpServer | null
  readonly memory?: RuntimeMcpServer | null
  readonly openConnector?: RuntimeMcpServer | null
  readonly imported?: ReadonlyArray<RuntimeMcpServer>
}

/** Assign source risks centrally; remote annotations cannot weaken these policies. */
export const jinglerMcpSources = (
  attachments: JinglerMcpAttachments,
  /** Live view of the CURRENT turn's attachments — see `McpToolSource.resolveServer`. */
  live?: () => JinglerMcpAttachments | undefined
): ReadonlyArray<McpToolSource> => [
  ...(attachments.browser
    ? [{
        server: attachments.browser,
        risk: "execute" as const,
        ...(live ? { resolveServer: () => live()?.browser ?? null } : {})
      }]
    : []),
  ...(attachments.memory
    ? [{
        server: attachments.memory,
        risk: "network" as const,
        ...(live ? { resolveServer: () => live()?.memory ?? null } : {})
      }]
    : []),
  ...(attachments.openConnector
    ? [{
        server: attachments.openConnector,
        risk: "execute" as const,
        ...(live ? { resolveServer: () => live()?.openConnector ?? null } : {})
      }]
    : []),
  ...(attachments.imported ?? []).map((server) => ({
    server,
    risk: "execute" as const,
    ...(live
      ? {
          resolveServer: () =>
            live()?.imported?.find((candidate) => candidate.name === server.name) ?? null
        }
      : {})
  }))
]

const clientFailure = (
  serverName: string,
  message: string,
  cause?: unknown
): McpToolBridgeError => new McpToolBridgeError({ serverName, message, cause })

const closeClient = (client: Client): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => client.close(),
    catch: () => null
  }).pipe(Effect.ignore)

export const makeMcpToolClient: McpToolClientFactory = (server) =>
  Effect.tryPromise({
      try: async () => {
        const client = new Client({ name: "jingler-pi-runtime", version: "1.0.0" })
        const transport = transportFor(server)
        await client.connect(transport)
        return client
      },
      catch: (cause) =>
        clientFailure(server.name, `Could not connect to MCP server ${server.name}`, cause)
    }).pipe(
    Effect.map((client): McpToolClient => ({
      listTools: (cursor) =>
        Effect.tryPromise({
          try: () => client.listTools(cursor === undefined ? undefined : { cursor }),
          catch: (cause) =>
            clientFailure(server.name, `Could not list tools from ${server.name}`, cause)
        }),
      callTool: (name, args, signal) =>
        Effect.tryPromise({
          try: async () => {
            const response = await client.callTool(
              { name, arguments: args },
              CallToolResultSchema,
              { signal, timeout: TOOL_TIMEOUT_MS }
            )
            const parsed = CallToolResultSchema.safeParse(response)
            if (!parsed.success) {
              throw new Error("MCP server returned an invalid tool result")
            }
            return parsed.data
          },
          catch: (cause) =>
            clientFailure(server.name, `MCP tool ${name} failed`, cause)
        }),
      close: closeClient(client)
    }))
  )

const authenticatedFetch = (
  headers: Readonly<Record<string, string>>
) => (url: string | URL, init: RequestInit): Promise<Response> => {
  const merged = new Headers(init.headers)
  for (const [key, value] of Object.entries(headers)) merged.set(key, value)
  return fetch(url, { ...init, headers: merged })
}

const transportFor = (server: RuntimeMcpServer) => {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      env: { ...getDefaultEnvironment(), ...server.env },
      cwd: server.cwd,
      stderr: "pipe"
    })
  }
  const url = new URL(server.url)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP URL must use http or https")
  }
  return server.transport === "sse"
    ? new SSEClientTransport(url, {
        eventSourceInit: { fetch: authenticatedFetch(server.headers) },
        requestInit: { headers: server.headers }
      })
    : new StreamableHTTPClientTransport(url, {
        requestInit: { headers: server.headers }
      })
}

const withClient = <A>(
  factory: McpToolClientFactory,
  server: RuntimeMcpServer,
  use: (client: McpToolClient) => Effect.Effect<A, McpToolBridgeError>
): Effect.Effect<A, McpToolBridgeError> =>
  Effect.acquireUseRelease(
    factory(server),
    use,
    (client) => client.close
  )

const discoverTools = (
  factory: McpToolClientFactory,
  server: RuntimeMcpServer
): Effect.Effect<ReadonlyArray<Tool>, McpToolBridgeError> =>
  withClient(factory, server, (client) =>
    Effect.gen(function* () {
      const tools: Tool[] = []
      let cursor: string | undefined
      for (let page = 0; page < TOOL_PAGE_LIMIT; page += 1) {
        const result = yield* client.listTools(cursor)
        tools.push(...result.tools)
        cursor = result.nextCursor
        if (cursor === undefined) return tools
      }
      return yield* clientFailure(
        server.name,
        `MCP server ${server.name} exceeded the tool pagination limit`
      )
    })
  )

const safeName = (name: string): string =>
  name.replaceAll(/[^a-zA-Z0-9_-]/g, "_")

const registeredName = (serverName: string, toolName: string): string =>
  `mcp__${safeName(serverName)}__${safeName(toolName)}`

const callResult = (result: CallToolResult): CallToolResult => {
  if (result.isError === true) {
    const message = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
    throw new ToolError(
      "execution-failed",
      message.length > 0 ? message : "MCP tool returned an error"
    )
  }
  return result
}

const registerTool = (
  registry: ToolRegistry,
  source: McpToolSource,
  tool: Tool,
  factory: McpToolClientFactory
): void => {
  const validate = validator.getValidator<Readonly<Record<string, unknown>>>(
    tool.inputSchema
  )
  registry.register({
    id: registeredName(source.server.name, tool.name),
    version: "1",
    description: tool.description ?? `${source.server.name} MCP tool ${tool.name}`,
    input: argumentsSchema,
    providerInputSchema: tool.inputSchema,
    risk: source.risk,
    roles,
    modes,
    timeoutMs: TOOL_TIMEOUT_MS,
    outputBudget: TOOL_OUTPUT_BUDGET,
    cancellable: true,
    idempotency:
      tool.annotations?.idempotentHint === true ? "keyed" : "unsafe",
    execute: (args, context) => {
      const checked = validate(args)
      if (!checked.valid) {
        throw new ToolError(
          "invalid-input",
          checked.errorMessage ?? `Invalid arguments for MCP tool ${tool.name}`
        )
      }
      return Effect.runPromise(
        withClient(factory, source.resolveServer?.() ?? source.server, (client) =>
          client.callTool(tool.name, checked.data, context.signal)
        ).pipe(
          Effect.map(callResult),
          Effect.mapError(
            (cause) =>
              new ToolError("execution-failed", cause.message)
          )
        )
      )
    }
  })
}

const discoverSource = (
  factory: McpToolClientFactory,
  source: McpToolSource
): Effect.Effect<McpDiscovery> =>
  discoverTools(factory, source.server).pipe(
    Effect.match({
      onFailure: (error) => ({ source, error, tools: null }),
      onSuccess: (tools) => ({ source, error: null, tools })
    })
  )

const availableDiscoveries = (
  discovered: ReadonlyArray<McpDiscovery>
): ReadonlyArray<McpDiscovery & { readonly tools: ReadonlyArray<Tool> }> =>
  discovered.filter(
    (entry): entry is McpDiscovery & { readonly tools: ReadonlyArray<Tool> } =>
      entry.tools !== null
  )

const validateDiscoveries = (
  registry: ToolRegistry,
  discovered: ReadonlyArray<McpDiscovery & { readonly tools: ReadonlyArray<Tool> }>
): void => {
  const names = new Set<string>()
  for (const { source, tools } of discovered) {
    for (const tool of tools) {
      const name = registeredName(source.server.name, tool.name)
      if (names.has(name) || !registry.canRegister(name)) {
        throw new Error(`duplicate or invalid MCP tool id: ${name}`)
      }
      validator.getValidator(tool.inputSchema)
      names.add(name)
    }
  }
}

const registerDiscoveries = (
  registry: ToolRegistry,
  discovered: ReadonlyArray<McpDiscovery & { readonly tools: ReadonlyArray<Tool> }>,
  factory: McpToolClientFactory
): void => {
  for (const { source, tools } of discovered) {
    for (const tool of tools) registerTool(registry, source, tool, factory)
  }
}

const registrationReport = (
  discovered: ReadonlyArray<McpDiscovery>
): McpToolRegistrationReport => ({
  health: discovered.map(({ source, error }) => ({
    name: source.server.name,
    status: error === null ? "healthy" : "failed"
  })),
  failures: discovered.flatMap(({ error }) => error === null ? [] : [error])
})

/** Discover and namespace MCP tools into the authoritative Jingler registry. */
export const registerMcpTools = (
  registry: ToolRegistry,
  sources: ReadonlyArray<McpToolSource>,
  factory: McpToolClientFactory = makeMcpToolClient
): Effect.Effect<McpToolRegistrationReport, McpToolBridgeError> =>
  Effect.forEach(
    sources,
    (source) => discoverSource(factory, source),
    { concurrency: 4 }
  ).pipe(
    Effect.flatMap((discovered) => Effect.try({
      try: () => {
        const available = availableDiscoveries(discovered)
        validateDiscoveries(registry, available)
        registerDiscoveries(registry, available, factory)
        return registrationReport(discovered)
      },
      catch: (cause) => clientFailure(
        "managed-mcp",
        "Could not register the managed MCP tool catalog",
        cause
      )
    }))
  )
