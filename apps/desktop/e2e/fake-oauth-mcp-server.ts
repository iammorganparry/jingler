import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeOAuthMcpServer {
  readonly url: string
  readonly registrations: () => number
  readonly close: () => Promise<void>
}

const body = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  try { return raw === "" ? {} : JSON.parse(raw) } catch { return {} }
}

type Json = (status: number, value: unknown, headers?: Record<string, string>) => void

const metadata = (base: string) => ({
  issuer: base,
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/token`,
  registration_endpoint: `${base}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"]
})

const mcpResult = (message: { method?: string; params?: { protocolVersion?: string } }) =>
  message.method === "initialize"
    ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-linear", version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "lookup", description: "Look something up", inputSchema: { type: "object", properties: {} } }] }
      : { content: [{ type: "text", text: "looked up" }] }

const handleMcp = async (request: IncomingMessage, response: ServerResponse, base: string, json: Json) => {
  if (request.headers.authorization !== "Bearer fake-token") {
    return json(401, { error: "unauthorized" }, {
      "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`
    })
  }
  const message = await body(request) as { id?: number; method?: string; params?: { protocolVersion?: string } }
  if (message.id === undefined) { response.writeHead(202); return void response.end() }
  json(200, { jsonrpc: "2.0", id: message.id, result: mcpResult(message) })
}

const authorize = (url: URL, response: ServerResponse) => {
  const redirect = new URL(url.searchParams.get("redirect_uri") ?? "")
  redirect.searchParams.set("code", "fake-code")
  redirect.searchParams.set("state", url.searchParams.get("state") ?? "")
  response.writeHead(302, { location: redirect.toString() })
  response.end()
}

/** MCP server behind dynamic-client-registration OAuth; one tool, `lookup`. */
export const startFakeOAuthMcpServer = async (): Promise<FakeOAuthMcpServer> => {
  let registrations = 0
  let base = ""
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base)
    const json: Json = (status, value, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers })
      response.end(JSON.stringify(value))
    }
    const path = url.pathname
    if (path.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (path.startsWith("/.well-known/oauth-authorization-server")) return json(200, metadata(base))
    if (path === "/register") {
      registrations += 1
      return json(201, { ...(await body(request)), client_id: "fake-client", token_endpoint_auth_method: "none" })
    }
    if (path === "/authorize") return authorize(url, response)
    if (path === "/token") {
      await body(request)
      return json(200, { access_token: "fake-token", token_type: "bearer" })
    }
    if (path !== "/mcp" || request.method !== "POST") return json(405, {})
    await handleMcp(request, response, base, json)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${base}/mcp`,
    registrations: () => registrations,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}
