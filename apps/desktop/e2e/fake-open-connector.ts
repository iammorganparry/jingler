import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A stateful fake OpenConnector instance for the e2e suite.
 *
 * A REAL HTTP server rather than a Playwright route stub, because the app fetches
 * from the Electron MAIN process — Playwright can only intercept renderer traffic,
 * so a stub would leave the very hop under test (main → instance) untested.
 *
 * It speaks three surfaces the app actually uses:
 * - `POST /mcp` — enough streamable-HTTP JSON-RPC (`initialize`, the `initialized`
 *   notification, `tools/list`) for the live probe that gates Settings › Connectors.
 * - `GET /v1/providers`, `GET|PUT|DELETE /api/connections`, `GET /api/oauth/configs`
 *   — the Connector Center's catalog and connection set.
 * - Everything else 404s, and every request must carry the seeded bearer, so a
 *   spec that forgets the token fails as "unauthorized" rather than silently
 *   passing against an open server.
 *
 * Stateful on purpose: a PUT shows up on the next GET, so connect/disconnect is
 * observable exactly the way the operator sees it.
 */

export const FAKE_TOKEN = "tok_e2e"

/**
 * The catalog entry shape the REAL instance returns (`service` / `displayName` /
 * `authTypes`), not the `id`/`name`/`auth[].fields` shape the parser also accepts.
 *
 * The parser tolerates both, and the fake used to send the richer one — which
 * meant the fixture exercised a branch the live server never takes, and hid that a
 * real api_key provider arrives with NO field list at all (the dialog falls back to
 * a generic "API key"). Verified against `ghcr.io/oomol-lab/open-connector:latest`.
 */
export interface FakeProvider {
  readonly service: string
  readonly displayName: string
  readonly iconUrl: string | null
  readonly homepageUrl: string | null
  readonly categories: ReadonlyArray<{ id: string; displayName: string }>
  readonly authTypes: ReadonlyArray<string>
}

const DEFAULT_PROVIDERS: ReadonlyArray<FakeProvider> = [
  {
    service: "github",
    displayName: "GitHub",
    iconUrl: null,
    homepageUrl: "https://github.com/",
    categories: [{ id: "Developer Tools", displayName: "Developer Tools" }],
    authTypes: ["api_key"]
  },
  {
    service: "slack",
    displayName: "Slack",
    iconUrl: null,
    homepageUrl: "https://slack.com/",
    categories: [{ id: "Communication", displayName: "Communication" }],
    authTypes: ["oauth2"]
  }
]

/**
 * The tools `tools/list` reports — the count the probe shows as "N tools".
 *
 * Named after the real instance's five: OpenConnector exposes a small fixed tool
 * set and routes to providers through it, rather than one tool per provider action.
 */
const TOOLS = [
  { name: "list_apps", inputSchema: { type: "object" } },
  { name: "list_connections", inputSchema: { type: "object" } },
  { name: "search_actions", inputSchema: { type: "object" } },
  { name: "get_action_guide", inputSchema: { type: "object" } },
  { name: "execute_action", inputSchema: { type: "object" } }
]

export interface FakeOpenConnector {
  readonly server: Server
  readonly port: number
  readonly endpoint: string
  /** Services currently connected, as the instance sees them. */
  readonly connections: () => ReadonlyArray<string>
  /** Authorization header values seen on `/mcp`, so a spec can assert the bearer really travels. */
  readonly mcpAuthHeaders: () => ReadonlyArray<string>
  readonly close: () => Promise<void>
}

export const startFakeOpenConnector = async (
  options: { readonly providers?: ReadonlyArray<FakeProvider> } = {}
): Promise<FakeOpenConnector> => {
  const providers = options.providers ?? DEFAULT_PROVIDERS
  const connected = new Set<string>()
  const mcpAuth: Array<string> = []

  const json = (res: ServerResponse, body: unknown) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(body))
  }

  const server = createServer((req, res) => {
    const url = req.url ?? ""
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      res.statusCode = 401
      return res.end("unauthorized")
    }

    if (req.method === "POST" && url.startsWith("/mcp")) {
      mcpAuth.push(req.headers.authorization)
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      return req.on("end", () => {
        const rpc = JSON.parse(body || "{}") as { id?: number; method?: string }
        // Notifications carry no id and expect no body.
        if (rpc.id === undefined) {
          res.statusCode = 202
          return res.end()
        }
        res.setHeader("mcp-session-id", "e2e-session")
        const result =
          rpc.method === "initialize"
            ? {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-open-connector", version: "0.0.0" }
              }
            : { tools: TOOLS }
        return json(res, { jsonrpc: "2.0", id: rpc.id, result })
      })
    }

    if (req.method === "GET" && url.startsWith("/v1/providers")) {
      return json(res, { data: providers })
    }
    if (req.method === "GET" && url.startsWith("/api/connections")) {
      return json(res, {
        data: [...connected].map((service) => ({
          service,
          accountId: `${service}_acct`,
          displayName: `${service} account`,
          grantedScopes: []
        }))
      })
    }
    if (req.method === "GET" && url.startsWith("/api/oauth/configs")) {
      return json(res, { data: [] })
    }
    if (req.method === "PUT" && url.startsWith("/api/connections/")) {
      connected.add(decodeURIComponent(url.split("/").pop() ?? ""))
      return json(res, { success: true })
    }
    if (req.method === "DELETE" && url.startsWith("/api/connections/")) {
      connected.delete(decodeURIComponent((url.split("?")[0] ?? "").split("/").pop() ?? ""))
      return json(res, { success: true })
    }

    res.statusCode = 404
    res.end("not found")
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    endpoint: `http://127.0.0.1:${port}`,
    connections: () => [...connected],
    mcpAuthHeaders: () => [...mcpAuth],
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** How many tools the fake reports — the number the probe's "connected" banner shows. */
export const FAKE_TOOL_COUNT = TOOLS.length
