import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { AgentRunSpec } from "@jingler/core"
import { Effect, JSONSchema } from "effect"
import type { AgentRuntimeContext } from "../agent/agent-runtime.js"
import { executeRegistryTool } from "../agent/registry-tool-bridge.js"
import { toolTarget } from "../agent/pi-events.js"
import type { ToolRegistry } from "../tools/tool-registry.js"
import type { RuntimeRemoteMcpServer } from "../mcp/attachment.js"

const tokenVariable = "JINGLER_TOOL_RELAY_TOKEN"

export interface RegistryMcpRelay {
  /** Secret-bearing, in-memory attachment; never persist or expose through RPC. */
  readonly attachment: RuntimeRemoteMcpServer
  readonly mcpConfigPath: string
  /** Passed only through the child environment; never serialized into config. */
  readonly environment: NodeJS.ProcessEnv
  readonly close: () => Promise<void>
}

export interface RegistryMcpRelayInput {
  readonly registry: ToolRegistry
  readonly spec: Pick<AgentRunSpec, "role" | "mode">
  readonly context: AgentRuntimeContext
}

const jsonError = (response: ServerResponse, status: number): void => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: null }))
}

/** A stateless MCP transport per HTTP request allows overlapping calls without
 * replacing another request's response channel. The registry owns execution,
 * permission policy, mutation receipts and output bounds for every invocation. */
export const startRegistryMcpRelay = async (
  input: RegistryMcpRelayInput
): Promise<RegistryMcpRelay> => {
  const token = randomBytes(32).toString("base64url")
  const authorization = Buffer.from(`Bearer ${token}`)
  const controller = new AbortController()
  const servers = new Set<Server>()
  const pending = new Set<Promise<void>>()
  const executions = new Set<Promise<unknown>>()
  let expectedHost = ""
  let closing: Promise<void> | undefined
  // Mutations share worktree snapshots and a journal. Serialize their complete
  // permission/execution/observation cycle, while reads remain concurrent.
  let mutationTail: Promise<unknown> = Promise.resolve()
  const capabilities = input.registry.capabilitiesFor(input.spec.role, input.spec.mode)
  const active = new Set(capabilities.map(({ id }) => id))
  const descriptors = capabilities.map(({ id, description }) => ({
    name: id,
    description,
    inputSchema: {
      ...(input.registry.providerInputSchemaFor(id) ?? JSONSchema.make(input.registry.inputSchemaFor(id)!)),
      type: "object" as const
    }
  }))
  const directory = await mkdtemp(join(tmpdir(), "jingler-claude-mcp-"))
  const mcpConfigPath = join(directory, "mcp.json")
  const http = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "")
    if (controller.signal.aborted || request.headers.host !== expectedHost ||
      request.url !== "/mcp" || request.headers.origin !== undefined ||
      supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      jsonError(response, 403)
      return
    }
    const server = new Server({ name: "jingler", version: "1.0.0" }, { capabilities: { tools: {} } })
    servers.add(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: descriptors }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const execute = async () => {
        const toolCallId = randomUUID()
        await Effect.runPromise(input.context.publishEvent({
          _tag: "ToolStart", id: toolCallId, name: params.name, target: toolTarget(params.arguments)
        }))
        try {
          let updates = Promise.resolve()
          const result = await executeRegistryTool({
            ...input,
            id: params.name,
            toolCallId,
            parameters: params.arguments ?? {},
            signal: AbortSignal.any([controller.signal, extra.signal]),
            allowed: active.has(params.name),
            onUpdate: (result) => {
              updates = updates.then(() => Effect.runPromise(input.context.publishEvent({
                _tag: "ToolDelta", id: toolCallId,
                output: result.content.map(({ text }) => text).join("\n")
              })))
            }
          })
          await updates
          await Effect.runPromise(input.context.publishEvent({
            _tag: "ToolEnd", id: toolCallId,
            status: result.details.status === "success" ? "success" : "error",
            meta: null, diff: null, preview: result.details.preview,
            output: result.content.map(({ text }) => text).join("\n"),
            ...(result.details.fileChanges === undefined ? {} : { fileChanges: result.details.fileChanges })
          }))
          return { content: result.content, isError: result.details.status !== "success" }
        } catch {
          const output = "Tool execution failed or was cancelled"
          await Effect.runPromise(input.context.publishEvent({
            _tag: "ToolEnd", id: toolCallId, status: "error", meta: null, diff: null, preview: null, output
          }))
          return { content: [{ type: "text" as const, text: output }], isError: true }
        }
      }
      const risk = input.registry.riskFor(params.name)
      const mutating = risk === "mutate" || risk === "execute"
      const result = mutating ? mutationTail.then(execute, execute) : execute()
      if (mutating) mutationTail = result.catch(() => undefined)
      executions.add(result)
      try { return await result } finally { executions.delete(result) }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const work = (async () => {
      try {
        await server.connect(transport)
        await transport.handleRequest(request, response)
        // handleRequest may return before the async JSON-RPC handler responds.
        if (!response.writableFinished && !response.destroyed) {
          await new Promise<void>((resolve) => {
            response.once("finish", resolve)
            response.once("close", resolve)
          })
        }
      } catch {
        if (!response.headersSent) jsonError(response, 500)
        else response.destroy()
      } finally {
        await server.close().catch(() => undefined)
        servers.delete(server)
      }
    })()
    pending.add(work)
    void work.finally(() => pending.delete(work))
  })
  const close = (): Promise<void> => closing ??= (async () => {
    controller.abort()
    const closed = new Promise<void>((resolve) => {
      http.close(() => resolve())
      http.closeAllConnections()
    })
    await Promise.allSettled(executions)
    await Promise.allSettled(pending)
    await Promise.allSettled([...servers].map((server) => server.close()))
    await closed
    await rm(directory, { recursive: true, force: true })
  })()
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject)
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject)
        resolve()
      })
    })
    expectedHost = `127.0.0.1:${(http.address() as AddressInfo).port}`
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: { jingler: {
        type: "http",
        url: `http://${expectedHost}/mcp`,
        headers: { Authorization: `Bearer \${${tokenVariable}}` }
      } }
    }), { mode: 0o600 })
    return {
      attachment: { name: "jingler", transport: "http", url: `http://${expectedHost}/mcp`, headers: { Authorization: `Bearer ${token}` } },
      mcpConfigPath, environment: { [tokenVariable]: token }, close
    }
  } catch (cause) {
    await close()
    throw cause
  }
}
