import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A stateful fake OpenConnector instance for the e2e suite.
 *
 * A REAL HTTP server rather than a Playwright route stub, because the app fetches
 * from the Electron MAIN process — Playwright can only intercept renderer traffic,
 * so a stub would leave the very hop under test (main → instance) untested.
 *
 * It speaks four surfaces the app actually uses:
 * - `POST /mcp` — enough streamable-HTTP JSON-RPC (`initialize`, the `initialized`
 *   notification, `tools/list`) for the live probe that gates Settings › Connectors.
 * - `GET /v1/providers` — the lean catalog the grid renders.
 * - `GET /api/providers/{service}` — ONE provider's auth descriptors, which is
 *   where the connect form gets its real labels and placeholders. Note there is
 *   no `GET /api/providers` here on purpose: the real one is ~5 MB and the app
 *   must never call it, so a regression that does 404s loudly.
 * - `GET|PUT|DELETE /api/connections`, `GET /api/oauth/configs` — the connection set.
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
  /**
   * The `auth[]` descriptors `GET /api/providers/{service}` returns. Absent from
   * the LIST response by design — that asymmetry is the whole reason the app
   * needs a second, per-provider call, so the fake reproduces it exactly.
   */
  readonly auth?: ReadonlyArray<Record<string, unknown>>
}

const DEFAULT_PROVIDERS: ReadonlyArray<FakeProvider> = [
  {
    service: "github",
    displayName: "GitHub",
    iconUrl: null,
    homepageUrl: "https://github.com/",
    categories: [{ id: "Developer Tools", displayName: "Developer Tools" }],
    authTypes: ["api_key"],
    auth: [
      {
        type: "api_key",
        label: "Personal access token",
        placeholder: "ghp_...",
        description: "Create one at github.com/settings/tokens."
      }
    ]
  },
  {
    service: "slack",
    displayName: "Slack",
    iconUrl: null,
    homepageUrl: "https://slack.com/",
    categories: [{ id: "Communication", displayName: "Communication" }],
    authTypes: ["oauth2"],
    auth: [{ type: "oauth2", scopes: ["channels:read", "chat:write"] }]
  },
  // Offers BOTH modes — the case the segmented control in the detail sheet exists
  // for, and the one the old single-form dialog could not represent.
  {
    service: "linear",
    displayName: "Linear",
    iconUrl: null,
    homepageUrl: "https://linear.app",
    categories: [{ id: "Productivity", displayName: "Productivity" }],
    authTypes: ["oauth2", "api_key"],
    auth: [
      { type: "oauth2", scopes: ["read", "write", "issues:create"] },
      { type: "api_key", label: "Personal API Key", placeholder: "lin_api_..." }
    ]
  },
  // Needs no credential at all, and the instance reports it as already connected.
  // Omitting `no_auth` from the auth-type union used to put a credential form in
  // front of providers like this one.
  {
    service: "hackernews",
    displayName: "Hacker News",
    iconUrl: null,
    homepageUrl: "https://news.ycombinator.com",
    categories: [{ id: "Data", displayName: "Data" }],
    authTypes: ["no_auth"],
    auth: [{ type: "no_auth" }]
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
  /**
   * `no_auth` providers arrive already usable — the real instance reports them as
   * `virtual: true, configured: true` connections you cannot disconnect. Keeping
   * them out of `connected` means the connect/disconnect assertions still only
   * see what the operator actually did.
   */
  const virtual = providers.filter((p) => p.authTypes.includes("no_auth"))

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
      // The LIST shape: no `auth[]`. Stripping it here is the point — if the app
      // ever reads fields off this response again, the form goes generic and the
      // detail test fails.
      return json(res, {
        data: providers.map(({ auth: _auth, ...rest }) => rest)
      })
    }
    // ONE provider's descriptors. There is deliberately no `/api/providers` list
    // route: the real one is ~5 MB, so calling it must 404 here.
    if (req.method === "GET" && /^\/api\/providers\/[^/]+$/.test(url.split("?")[0] ?? "")) {
      const service = decodeURIComponent((url.split("?")[0] ?? "").split("/").pop() ?? "")
      const provider = providers.find((p) => p.service === service)
      if (!provider) {
        res.statusCode = 404
        return res.end("not found")
      }
      return json(res, { data: { ...provider, actions: [] } })
    }
    if (req.method === "GET" && url.startsWith("/api/connections")) {
      // The account hangs off `profile`, exactly as the real instance sends it —
      // reading it at the root is why connected rows used to render blank.
      return json(res, {
        data: [
          ...virtual.map((p) => ({
            service: p.service,
            connectionName: "default",
            authType: "no_auth",
            configured: true,
            virtual: true,
            profile: {
              accountId: `${p.service}:public`,
              displayName: `${p.displayName} Public`,
              grantedScopes: []
            }
          })),
          ...[...connected].map((service) => ({
            service,
            connectionName: "default",
            configured: true,
            profile: {
              accountId: `${service}_acct`,
              displayName: `${service} account`,
              grantedScopes: []
            }
          }))
        ]
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
