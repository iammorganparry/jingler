import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { Effect } from "effect"
import type { ParsedMcpServer } from "./runtime/mcp/attachment.js"
import { McpAuthStore } from "./mcp-auth-store.js"
import {
  mcpOAuthClientMetadata,
  mcpOAuthConfiguredClient,
  type McpOAuthConfig
} from "./mcp-oauth.js"
import type { SecretStoreShape } from "./secret-store.js"

const FLOW_TIMEOUT_MS = 10 * 60_000
const activeFlows = new Map<string, { readonly identity: string; readonly flowId: string }>()

export const isMcpOAuthAuthorizationActive = (name: string, identity: string): boolean =>
  activeFlows.get(name)?.identity === identity

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
  setCommit: (commit: () => Promise<void>) => void
}>((resolve, reject) => {
  let transport: StreamableHTTPClientTransport | null = null
  let commit: (() => Promise<void>) | null = null
  let settle!: () => void
  let fail!: (cause: unknown) => void
  const finish = new Promise<void>((done, failed) => { settle = done; fail = failed })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/oauth/callback") return void response.writeHead(404).end()
    if (url.searchParams.get("state") !== state || transport === null || commit === null) {
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
    void transport.finishAuth(code).then(commit).then(() => {
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
      setTransport: (value) => { transport = value },
      setCommit: (value) => { commit = value }
    })
  })
})

const oauthEndpoint = (entry: ParsedMcpServer): { readonly endpoint: string; readonly identity: string } => {
  if (
    entry.server.authKind !== "oauth" ||
    entry.launch.url === undefined ||
    entry.launch.transport !== "http" ||
    entry.credentialIdentity === undefined
  ) {
    throw new Error(`MCP server ${entry.server.name} does not support managed OAuth`)
  }
  return { endpoint: entry.launch.url, identity: entry.credentialIdentity }
}

const pendingProvider = (
  name: string,
  redirectUrl: string,
  state: string,
  config: McpOAuthConfig,
  redirect: (url: URL) => void
): { readonly provider: OAuthClientProvider; readonly credential: () => { tokens: OAuthTokens; clientInformation?: OAuthClientInformationMixed } } => {
  let clientInformation = mcpOAuthConfiguredClient(config)
  let tokens: OAuthTokens | undefined
  let verifier: string | undefined
  return {
    provider: {
      redirectUrl,
      clientMetadata: mcpOAuthClientMetadata(redirectUrl, config.scope),
      state: () => state,
      clientInformation: () => clientInformation,
      saveClientInformation: (value) => { clientInformation = value },
      tokens: () => undefined,
      saveTokens: (value) => { tokens = value },
      redirectToAuthorization: redirect,
      saveCodeVerifier: (value) => { verifier = value },
      codeVerifier: () => {
        if (verifier === undefined) throw new Error(`Missing OAuth verifier for MCP server ${name}`)
        return verifier
      },
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "tokens") tokens = undefined
        if ((scope === "all" || scope === "client") && mcpOAuthConfiguredClient(config) === undefined) {
          clientInformation = undefined
        }
        if (scope === "all" || scope === "verifier") verifier = undefined
      }
    },
    credential: () => {
      if (tokens === undefined) throw new Error(`MCP server ${name} returned no OAuth tokens`)
      return { tokens, ...(clientInformation === undefined ? {} : { clientInformation }) }
    }
  }
}

const connectForAuthorization = async (
  client: Client,
  transport: StreamableHTTPClientTransport,
  deadline: Promise<never>
): Promise<void> => {
  try {
    await Promise.race([client.connect(transport), deadline])
  } catch (cause) {
    if (!(cause instanceof UnauthorizedError)) throw cause
  }
}

/** Start one RFC 8252 loopback OAuth flow and return the browser URL. */
export const startMcpOAuthAuthorization = (
  entry: ParsedMcpServer,
  secretStore: SecretStoreShape,
  timeoutMs: number = FLOW_TIMEOUT_MS
): Effect.Effect<string, Error> => Effect.tryPromise({
  try: async () => {
    const { endpoint, identity } = oauthEndpoint(entry)
    const name = entry.server.name
    if (activeFlows.has(name)) throw new Error(`Authorization for ${name} is already in progress`)
    const flowId = randomBytes(24).toString("hex")
    activeFlows.set(name, { identity, flowId })
    const authStore = new McpAuthStore(secretStore)
    let loopback: Awaited<ReturnType<typeof listen>> | null = null
    let client: Client | null = null
    let rejectTimeout!: (cause: Error) => void
    const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
    const current = () => activeFlows.get(name)?.flowId === flowId
    const cleanup = () => {
      loopback?.server.close()
      void client?.close().catch(() => {})
      if (current()) activeFlows.delete(name)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectTimeout(new Error(`Authorization for ${name} timed out`))
    }, timeoutMs)
    try {
      loopback = await Promise.race([listen(flowId), deadline])
      const authorization = { url: null as string | null }
      const pending = pendingProvider(
        name,
        loopback.redirectUrl,
        flowId,
        entry.launch.oauth ?? {},
        (url) => { authorization.url = url.toString() }
      )
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: entry.launch.headers },
        authProvider: pending.provider
      })
      loopback.setTransport(transport)
      loopback.setCommit(async () => {
        if (!current()) throw new Error(`Authorization for ${name} expired`)
        const credential = pending.credential()
        const written = await Effect.runPromise(authStore.writeIf(
          name,
          { type: "oauth", identity, ...credential },
          current,
          () => { clearTimeout(timer) }
        ))
        if (!written) throw new Error(`Authorization for ${name} expired`)
      })
      client = new Client({ name: "jingler", version: "1.0.0" })
      await connectForAuthorization(client, transport, deadline)
      if (authorization.url === null) throw new Error("MCP server did not provide an authorization URL")
      if (!isMcpAuthorizationUrlAllowed(new URL(authorization.url))) {
        throw new Error("MCP authorization URL must use HTTPS")
      }
      const settle = () => { clearTimeout(timer); cleanup() }
      void loopback.finish.then(settle, settle)
      return authorization.url
    } catch (cause) {
      clearTimeout(timer)
      cleanup()
      throw cause
    }
  },
  catch: (cause) => cause instanceof Error ? cause : new Error(String(cause))
})
