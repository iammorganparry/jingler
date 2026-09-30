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
import type { ProviderId, ProviderModelId, RuntimeDiagnosticMcpHealth } from "@jingler/core"
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
const progressiveSearchInput = Schema.Struct({
  query: Schema.String,
  server: Schema.optional(Schema.String)
})
const progressiveCallInput = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  arguments: argumentsSchema
})
type ProgressiveMcpMatch =
  | { readonly server: string; readonly error: string }
  | {
      readonly server: string
      readonly tool: string
      readonly description: string
      readonly inputSchema: Tool["inputSchema"]
    }
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
  /** Operator-configured servers from `~/jingler/mcp.json`. */
  readonly configured?: ReadonlyArray<RuntimeMcpServer>
}

const serverCapabilityIdentity = (server: RuntimeMcpServer): string =>
  `${server.name}:${server.transport ?? "http"}`

/**
 * Identify the MCP tool catalogs locked into a PI session without including
 * rotating URLs, headers, credentials, or other connection details.
 */
export const mcpCapabilityFingerprint = (
  attachments?: JinglerMcpAttachments
): string => JSON.stringify([
  ...(attachments?.browser
    ? [`browser:${serverCapabilityIdentity(attachments.browser)}`]
    : []),
  ...(attachments?.configured ?? [])
    .map((server) => `configured:${serverCapabilityIdentity(server)}`)
    .sort()
])

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
  ...(attachments.configured ?? []).map((server) => ({
    server,
    risk: "execute" as const,
    ...(live
      ? {
          resolveServer: () =>
            live()?.configured?.find((candidate) => candidate.name === server.name) ?? null
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

export interface McpClientIdentity {
  readonly name: string
  readonly title?: string
}

export const mcpClientIdentityForModel = (
  providerId: ProviderId | undefined,
  modelId: ProviderModelId
): McpClientIdentity => {
  const model = modelId.toLowerCase()
  if (providerId === "anthropic" || model.startsWith("anthropic/") || model.includes("claude")) {
    return { name: "claude-code", title: "Claude Code" }
  }
  if (providerId === "openai-codex" || model.startsWith("openai-codex/") || model.includes("codex")) {
    return { name: "codex-mcp-client", title: "Codex" }
  }
  return { name: "jingler-pi-runtime" }
}

export const makeMcpToolClientFactory = (identity: McpClientIdentity): McpToolClientFactory => (server) =>
  Effect.tryPromise({
      try: async () => {
        const client = new Client({ ...identity, version: "1.0.0" })
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

export const makeMcpToolClient = makeMcpToolClientFactory({ name: "jingler-pi-runtime" })

const authenticatedFetch = (
  headers: Readonly<Record<string, string>>,
  onUnauthorized?: () => void
) => async (url: string | URL, init?: RequestInit): Promise<Response> => {
  const merged = new Headers(init?.headers)
  for (const [key, value] of Object.entries(headers)) merged.set(key, value)
  const response = await fetch(url, { ...init, headers: merged })
  if (response.status === 401) onUnauthorized?.()
  return response
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
        eventSourceInit: { fetch: authenticatedFetch(server.headers, server.onUnauthorized) },
        requestInit: { headers: server.headers }
      })
    : new StreamableHTTPClientTransport(url, {
        requestInit: { headers: server.headers },
        authProvider: server.authProvider,
        fetch: authenticatedFetch({}, server.onUnauthorized)
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
        withClient(factory, resolvedServer(source), (client) =>
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
  Effect.try({
    try: () => resolvedServer(source),
    catch: (cause) => cause instanceof McpToolBridgeError
      ? cause
      : clientFailure(source.server.name, `MCP server is unavailable for this turn: ${source.server.name}`, cause)
  }).pipe(
    Effect.flatMap((server) => discoverTools(factory, server)),
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

const resolvedServer = (source: McpToolSource): RuntimeMcpServer => {
  if (source.resolveServer === undefined) return source.server
  const current = source.resolveServer()
  if (current === null) {
    throw clientFailure(source.server.name, `MCP server is unavailable for this turn: ${source.server.name}`)
  }
  return current
}

const sourceByName = (
  sources: ReadonlyArray<McpToolSource>,
  name: string
): McpToolSource => {
  const source = sources.find((candidate) => candidate.server.name === name)
  if (source === undefined) throw new ToolError("invalid-input", `Unknown MCP server: ${name}`)
  return source
}

const progressiveHealth = (
  sources: ReadonlyArray<McpToolSource>,
  statuses: ReadonlyMap<string, RuntimeDiagnosticMcpHealth["status"]>
): ReadonlyArray<RuntimeDiagnosticMcpHealth> =>
  sources.map(({ server }) => ({
    name: server.name,
    status: statuses.get(server.name) ?? "closed"
  }))

/**
 * Register a stable two-tool MCP surface instead of copying every remote schema
 * into every provider request. Server catalogs are opened only when the model
 * searches or calls them; the selected schema travels in the tool result and
 * therefore costs context only when it is relevant to the task.
 */
export const registerProgressiveMcpTools = (
  registry: ToolRegistry,
  sources: ReadonlyArray<McpToolSource>,
  factory: McpToolClientFactory = makeMcpToolClient
): void => {
  const existingHealth = registry.mcpHealth()
  const statuses = new Map<string, RuntimeDiagnosticMcpHealth["status"]>()
  const updateHealth = (name: string, status: RuntimeDiagnosticMcpHealth["status"]) => {
    statuses.set(name, status)
    registry.setMcpHealth([...existingHealth, ...progressiveHealth(sources, statuses)])
  }
  registry.setMcpHealth([...existingHealth, ...progressiveHealth(sources, statuses)])
  const serverNames = sources.map(({ server }) => server.name).join(", ")
  const callRisk: ToolRisk = sources.some(({ risk }) => risk === "execute") ? "execute" : "network"

  registry.register({
    id: "mcp_search",
    version: "1",
    description: `Discover configured MCP capabilities on demand. Search before mcp_call. Servers: ${serverNames}`,
    input: progressiveSearchInput,
    providerInputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability or tool name to find; use an empty string to list." },
        server: { type: "string", description: "Optional exact server name to narrow discovery." }
      },
      required: ["query"],
      additionalProperties: false
    },
    risk: "network",
    roles,
    modes,
    timeoutMs: TOOL_TIMEOUT_MS,
    outputBudget: TOOL_OUTPUT_BUDGET,
    cancellable: true,
    idempotency: "safe",
    execute: async ({ query, server: requested }) => {
      const selected = requested === undefined ? sources : [sourceByName(sources, requested)]
      const needle = query.trim().toLocaleLowerCase()
      const discoveries = await Effect.runPromise(Effect.forEach(
        selected,
        (source) => discoverSource(factory, source),
        { concurrency: 4 }
      ))
      for (const discovery of discoveries) {
        updateHealth(discovery.source.server.name, discovery.error === null ? "healthy" : "failed")
      }
      const matches = discoveries.flatMap<ProgressiveMcpMatch>(({ source, tools, error }) =>
        error !== null
          ? [{ server: source.server.name, error: error.message }]
          : (tools ?? [])
              .filter((tool) => needle.length === 0 || `${tool.name} ${tool.description ?? ""}`.toLocaleLowerCase().includes(needle))
              .slice(0, 20)
              .map((tool) => ({
                server: source.server.name,
                tool: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema
              }))
      )
      return { matches: matches.slice(0, 40) }
    }
  })

  registry.register({
    id: "mcp_call",
    version: "1",
    description: "Call one configured MCP tool discovered with mcp_search.",
    input: progressiveCallInput,
    providerInputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Exact MCP server name returned by mcp_search." },
        tool: { type: "string", description: "Exact MCP tool name returned by mcp_search." },
        arguments: { type: "object", description: "Arguments matching the discovered inputSchema.", additionalProperties: true }
      },
      required: ["server", "tool", "arguments"],
      additionalProperties: false
    },
    risk: callRisk,
    roles,
    modes,
    timeoutMs: TOOL_TIMEOUT_MS,
    outputBudget: TOOL_OUTPUT_BUDGET,
    cancellable: true,
    idempotency: "unsafe",
    execute: async ({ server: serverName, tool: toolName, arguments: args }, context) => {
      const source = sourceByName(sources, serverName)
      try {
        const tools = await Effect.runPromise(discoverTools(factory, resolvedServer(source)))
        updateHealth(serverName, "healthy")
        const tool = tools.find((candidate) => candidate.name === toolName)
        if (tool === undefined) throw new ToolError("invalid-input", `Unknown MCP tool: ${serverName}/${toolName}`)
        const checked = validator.getValidator<Readonly<Record<string, unknown>>>(tool.inputSchema)(args)
        if (!checked.valid) throw new ToolError("invalid-input", checked.errorMessage ?? `Invalid arguments for MCP tool ${toolName}`)
        const result = await Effect.runPromise(withClient(
          factory,
          resolvedServer(source),
          (client) => client.callTool(toolName, checked.data, context.signal)
        ))
        return callResult(result)
      } catch (cause) {
        if (cause instanceof ToolError) throw cause
        updateHealth(serverName, "failed")
        throw new ToolError("execution-failed", cause instanceof Error ? cause.message : `MCP tool ${toolName} failed`)
      }
    }
  })
}
