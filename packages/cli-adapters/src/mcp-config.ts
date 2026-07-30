import type { McpServer, McpTransport } from "@jingler/core"
import type { RemoteMcpServer } from "./adapter.js"

/**
 * The write-side of MCP config: given one normalized remote attachment from
 * `SessionSpec.remoteMcpServers`, render it into each harness's OWN launch
 * vocabulary, plus the parsing utilities the rest of the OpenConnector code
 * shares.
 *
 * (Jingler used to READ each harness's own MCP config here too; that's gone.
 * OpenConnector still uses the `ParsedMcpServer` split while AgentRunner reduces
 * every launch source to the normalized remote shape.)
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

/** Drop the renderer-safe half after a remote entry reaches the main-only run boundary. */
export const remoteMcpServer = (
  entry: ParsedMcpServer | null | undefined
): RemoteMcpServer | null =>
  entry?.launch.url === undefined
    ? null
    : {
        name: entry.server.name,
        url: entry.launch.url,
        headers: entry.launch.headers
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
// Render normalized remote servers into each harness's launch vocabulary.
// Claude takes the complete collection via the SDK `mcpServers` option (see
// `claude-adapter.ts`); the two below are the Codex + opencode equivalents.
// Both are pure so the wiring is unit-tested without spawning a harness.

/** Preserve input order and the first occurrence of any duplicated server name. */
const uniqueRemoteMcpServers = (
  entries: ReadonlyArray<RemoteMcpServer> | null | undefined
): ReadonlyArray<RemoteMcpServer> => {
  const names = new Set<string>()
  return (entries ?? []).filter((entry) => {
    if (names.has(entry.name)) return false
    names.add(entry.name)
    return true
  })
}

/**
 * Codex `-c` config overrides that register each server as a remote MCP for the
 * app-server spawn: `["-c", 'mcp_servers.<name>.url="…"', "-c", …]`. Empty
 * when absent. Values are JSON-encoded, which is a valid TOML basic string
 * (same `"`/`\` escapes).
 */
export const codexMcpOverrides = (
  entries: ReadonlyArray<RemoteMcpServer> | null | undefined
): ReadonlyArray<string> => {
  const overrides: string[] = []
  for (const entry of uniqueRemoteMcpServers(entries)) {
    overrides.push(`mcp_servers.${entry.name}.url=${JSON.stringify(entry.url)}`)
    for (const [key, value] of Object.entries(entry.headers)) {
      overrides.push(
        `mcp_servers.${entry.name}.http_headers.${key}=${JSON.stringify(value)}`
      )
    }
  }
  return overrides
}

/**
 * The opencode `mcp` config fragment to merge into `OPENCODE_CONFIG_CONTENT`:
 * `{ mcp: { <name>: { type: "remote", url, enabled, headers? }, … } }`. Empty
 * when absent, so spreading it is a no-op.
 */
export const opencodeMcpConfig = (
  entries: ReadonlyArray<RemoteMcpServer> | null | undefined
): Record<string, unknown> => {
  const unique = uniqueRemoteMcpServers(entries)
  if (unique.length === 0) return {}
  return {
    mcp: Object.fromEntries(
      unique.map((entry) => [
        entry.name,
        {
          type: "remote",
          url: entry.url,
          enabled: true,
          ...(Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {})
        }
      ])
    )
  }
}
