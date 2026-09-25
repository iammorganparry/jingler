import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { Tool } from "@earendil-works/pi-ai"

export interface RelayedToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface ClaudeCliToolRelay {
  readonly mcpConfigPath: string
  readonly toolCall: Promise<RelayedToolCall>
  readonly close: () => Promise<void>
}

const jsonError = (response: ServerResponse, status: number, message: string): void => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32_000, message }, id: null }))
}

const authorized = (
  request: IncomingMessage,
  expectedHost: string,
  token: string
): boolean =>
  request.headers.host === expectedHost &&
  request.headers.authorization === `Bearer ${token}` &&
  new URL(request.url ?? "/", `http://${expectedHost}`).pathname === "/mcp"

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
  token: string,
  tools: ReadonlyArray<Tool>,
  capture: (call: RelayedToolCall) => void
): Promise<void> => {
  if (!authorized(request, expectedHost, token)) {
    jsonError(response, 403, "Forbidden")
    return
  }
  const server = new Server(
    { name: "jingler", version: "1.0.0" },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.parameters, type: "object" as const }
    }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    capture({
      id: randomBytes(12).toString("hex"),
      name: params.name,
      arguments: params.arguments ?? {}
    })
    return {
      content: [{ type: "text", text: "Tool call relayed to Jingler." }]
    }
  })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(request, response)
  } finally {
    await server.close().catch(() => undefined)
  }
}

const closeServer = (server: HttpServer): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })

export const startClaudeCliToolRelay = async (
  tools: ReadonlyArray<Tool>
): Promise<ClaudeCliToolRelay> => {
  const token = randomBytes(32).toString("base64url")
  let expectedHost = ""
  let settled = false
  let resolveToolCall!: (call: RelayedToolCall) => void
  const toolCall = new Promise<RelayedToolCall>((resolve) => {
    resolveToolCall = resolve
  })
  const capture = (call: RelayedToolCall): void => {
    if (settled) return
    settled = true
    resolveToolCall(call)
  }
  const directory = await mkdtemp(join(tmpdir(), "jingler-claude-mcp-"))
  const mcpConfigPath = join(directory, "mcp.json")
  const server = createServer((request, response) => {
    handleRequest(request, response, expectedHost, token, tools, capture).catch(() => {
      if (!response.headersSent) jsonError(response, 500, "Internal server error")
      else response.destroy()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    expectedHost = `127.0.0.1:${address.port}`
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        jingler: {
          type: "http",
          url: `http://${expectedHost}/mcp`,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    }), { mode: 0o600 })
  } catch (cause) {
    await closeServer(server)
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
  return {
    mcpConfigPath,
    toolCall,
    close: async () => {
      await closeServer(server)
      await rm(directory, { recursive: true, force: true })
    }
  }
}
