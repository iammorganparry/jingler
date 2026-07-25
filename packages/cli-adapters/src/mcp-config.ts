import type { McpServer, McpTransport } from "@starbase/core"

/**
 * The write-side of MCP config: given the resolved OpenConnector server
 * (`SessionSpec.openConnector`, a remote `ParsedMcpServer`), render it into each
 * harness's OWN launch vocabulary so every agent loads the same shared server, plus
 * the small parsing utilities the rest of the OpenConnector code shares.
 *
 * (Starbase used to READ each harness's own MCP config here too; that's gone —
 * OpenConnector is now the single source of truth, so only the injection side and
 * the shared `ParsedMcpServer` split remain.)
 *
 * SECURITY — the `ParsedMcpServer` split. A remote server carries a bearer in its
 * headers, and two halves need different things:
 *   - `server` (`McpServer`) carries key NAMES only and is the only half that may
 *     cross the RPC boundary;
 *   - `launch` (`McpLaunch`) carries the real values and must never leave main.
 */

/** Everything needed to actually connect to a server. Main-process only — contains secrets. */
export interface McpLaunch {
  readonly transport: McpTransport
  /** stdio only. */
  readonly command?: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** remote only. */
  readonly url?: string
  readonly headers: Readonly<Record<string, string>>
}

/** A server entry, split into its safe-to-send half and its secret-bearing half. */
export interface ParsedMcpServer {
  /** Redacted. Safe to send to the renderer. */
  readonly server: McpServer
  /** Secrets. Never send this anywhere. */
  readonly launch: McpLaunch
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

export const strArray = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/**
 * Normalise an OpenConnector base URL: strip trailing slashes so `${base}${path}`
 * never doubles up. The SINGLE home for endpoint normalisation — both `mcpUrl`
 * (open-connector.ts) and the Connector-Center API client build on it, so a future
 * rule (e.g. dropping a pasted `/mcp` suffix) lands in one place.
 */
export const normalizeEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, "")

// ── Unified-MCP injection (write side) ───────────────────────────────────────
//
// Render the resolved OpenConnector server into each harness's launch vocabulary.
// Claude takes it via the SDK `mcpServers` option (see `claude-adapter.ts`); the
// two below are the codex + opencode halves. Both are pure so the wiring is
// unit-tested without spawning a harness.

/**
 * Codex `-c` config overrides that register the server as a remote MCP for the
 * app-server spawn: `["-c", 'mcp_servers.<name>.url="…"', "-c", …]`. Empty when
 * absent or not a remote (http) entry — codex only takes a URL here. Values are
 * JSON-encoded, which is a valid TOML basic string (same `"`/`\` escapes).
 */
export const codexMcpOverrides = (
  entry: ParsedMcpServer | null | undefined
): ReadonlyArray<string> => {
  if (!entry || entry.launch.url === undefined) return []
  const name = entry.server.name
  const out = [`mcp_servers.${name}.url=${JSON.stringify(entry.launch.url)}`]
  for (const [key, value] of Object.entries(entry.launch.headers)) {
    out.push(`mcp_servers.${name}.http_headers.${key}=${JSON.stringify(value)}`)
  }
  return out
}

/**
 * The opencode `mcp` config fragment to merge into `OPENCODE_CONFIG_CONTENT`:
 * `{ mcp: { <name>: { type: "remote", url, enabled, headers? } } }`. Empty when
 * absent or not a remote entry, so spreading it is a no-op.
 */
export const opencodeMcpConfig = (
  entry: ParsedMcpServer | null | undefined
): Record<string, unknown> => {
  if (!entry || entry.launch.url === undefined) return {}
  const hasHeaders = Object.keys(entry.launch.headers).length > 0
  return {
    mcp: {
      [entry.server.name]: {
        type: "remote",
        url: entry.launch.url,
        enabled: true,
        ...(hasHeaders ? { headers: entry.launch.headers } : {})
      }
    }
  }
}
