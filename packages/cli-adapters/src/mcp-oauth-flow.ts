import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { Effect } from "effect"
import type { ParsedMcpServer } from "./runtime/mcp/attachment.js"
import { McpAuthStore } from "./mcp-auth-store.js"
import { makeMcpOAuthProvider } from "./mcp-oauth.js"
import type { SecretStoreShape } from "./secret-store.js"

const FLOW_TIMEOUT_MS = 10 * 60_000
const activeFlows = new Map<string, string>()

const callbackPage = (message: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Jingler MCP</title></head>` +
  `<body style="font:14px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>${message}</p></body></html>`

export const isMcpAuthorizationUrlAllowed = (value: URL): boolean =>
  value.protocol === "https:" || (
    value.protocol === "http:" &&
    (value.hostname === "127.0.0.1" || value.hostname === "localhost" || value.hostname === "[::1]")
  )

const listen = (state: string) => new Promise<{
  server: ReturnType<typeof createServer>
  redirectUrl: string
  finish: Promise<void>
  setTransport: (transport: StreamableHTTPClientTransport) => void
}>((resolve, reject) => {
  let transport: StreamableHTTPClientTransport | null = null
  let settle!: () => void
  let fail!: (cause: unknown) => void
  const finish = new Promise<void>((done, failed) => { settle = done; fail = failed })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/oauth/callback") return void response.writeHead(404).end()
    if (url.searchParams.get("state") !== state || transport === null) {
      response.writeHead(403, { "content-type": "text/html" }).end(callbackPage("Invalid or expired authorization callback."))
      return
    }
    const code = url.searchParams.get("code")
    const error = url.searchParams.get("error")
    if (code === null) {
      response.writeHead(400, { "content-type": "text/html" }).end(callbackPage("Authorization failed. Return to Jingler and try again."))
      fail(new Error(error ?? "MCP authorization returned no code"))
      return
    }
    void transport.finishAuth(code).then(() => {
      response.writeHead(200, { "content-type": "text/html" }).end(callbackPage("Connected. You can close this tab and return to Jingler."))
      settle()
    }).catch((cause) => {
      response.writeHead(500, { "content-type": "text/html" }).end(callbackPage("Authorization failed. Return to Jingler and try again."))
      fail(cause)
    })
  })
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || address === null) return reject(new Error("Could not bind MCP OAuth callback"))
    resolve({
      server,
      redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
      finish,
      setTransport: (value) => { transport = value }
    })
  })
})

const oauthEndpoint = (entry: ParsedMcpServer): string => {
  if (entry.server.authKind !== "oauth" || entry.launch.url === undefined || entry.launch.transport !== "http") {
    throw new Error(`MCP server ${entry.server.name} does not support managed OAuth`)
  }
  return entry.launch.url
}

/** Start one RFC 8252 loopback OAuth flow and return the browser URL. */
export const startMcpOAuthAuthorization = (
  entry: ParsedMcpServer,
  secretStore: SecretStoreShape
): Effect.Effect<string, Error> => Effect.tryPromise({
  try: async () => {
    const endpoint = oauthEndpoint(entry)
    const name = entry.server.name
    if (activeFlows.has(name)) throw new Error(`Authorization for ${name} is already in progress`)
    const flowId = randomBytes(24).toString("hex")
    activeFlows.set(name, flowId)
    const authStore = new McpAuthStore(secretStore)
    let loopback: Awaited<ReturnType<typeof listen>> | null = null
    let client: Client | null = null
    const current = () => activeFlows.get(name) === flowId
    const reset = async () => {
      if (!current()) return
      await Effect.runPromise(authStore.update(name, (credential) =>
        credential?.type === "oauth" && credential.state === flowId && credential.tokens === undefined
          ? { type: "oauth" }
          : credential ?? { type: "oauth" }
      ))
    }
    const cleanup = () => {
      loopback?.server.close()
      void client?.close().catch(() => {})
      if (current()) activeFlows.delete(name)
    }
    try {
      await Effect.runPromise(authStore.write(name, { type: "oauth", state: flowId }))
      loopback = await listen(flowId)
      const authorization = { url: null as string | null }
      const provider = makeMcpOAuthProvider(
        name,
        authStore,
        loopback.redirectUrl,
        (url) => { authorization.url = url.toString() },
        flowId
      )
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: entry.launch.headers },
        authProvider: provider
      })
      loopback.setTransport(transport)
      client = new Client({ name: "jingler", version: "1.0.0" })
      try {
        await client.connect(transport)
      } catch (cause) {
        if (!(cause instanceof UnauthorizedError)) throw cause
      }
      if (authorization.url === null) throw new Error("MCP server did not provide an authorization URL")
      if (!isMcpAuthorizationUrlAllowed(new URL(authorization.url))) {
        throw new Error("MCP authorization URL must use HTTPS")
      }
      const timer = setTimeout(() => {
        void reset().catch(() => {}).then(cleanup)
      }, FLOW_TIMEOUT_MS)
      const settle = () => { clearTimeout(timer); cleanup() }
      void loopback.finish.then(settle, () => {
        void reset().catch(() => {}).then(settle)
      })
      return authorization.url
    } catch (cause) {
      await reset().catch(() => {})
      cleanup()
      throw cause
    }
  },
  catch: (cause) => cause instanceof Error ? cause : new Error(String(cause))
})
