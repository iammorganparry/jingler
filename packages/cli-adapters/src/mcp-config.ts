import type { McpServer, McpTransport } from "@jingler/core"
import { parse } from "smol-toml"
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
  /**
   * Optional header-to-environment-name map for harnesses that can keep secret
   * values out of process arguments. The concrete values remain in `headers`
   * for transports that need them directly.
   */
  readonly headerEnvironment?: Readonly<Record<string, string>>
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
        headers: entry.launch.headers,
        ...(entry.launch.headerEnvironment === undefined
          ? {}
          : { headerEnvironment: entry.launch.headerEnvironment })
      }

/**
 * Compose agent launch attachments in stable priority order.
 *
 * Keeping the first occurrence makes duplicate inputs deterministic. Callers
 * put Jingler-owned attachments first so an operator connector cannot shadow a
 * credential-bound internal service by claiming its reserved name.
 */
export const composeRemoteMcpServers = (
  ...entries: ReadonlyArray<RemoteMcpServer | null>
): ReadonlyArray<RemoteMcpServer> => {
  const names = new Set<string>()
  const attachments: RemoteMcpServer[] = []
  for (const entry of entries) {
    if (entry === null || names.has(entry.name)) continue
    names.add(entry.name)
    attachments.push(entry)
  }
  return attachments
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
 * Codex `-c` config overrides that apply Jingler's MCP approval policy and
 * register each attached server for the app-server spawn. Values are
 * JSON-encoded, which is a valid TOML basic string (same `"`/`\` escapes).
 */
export const codexMcpOverrides = (
  entries: ReadonlyArray<RemoteMcpServer> | null | undefined
): ReadonlyArray<string> => {
  const servers = uniqueRemoteMcpServers(entries)
  // Running Codex through Jingler is the operator's consent to use both the
  // servers attached here and connectors already present in Codex's user
  // configuration. Codex's stable tool-call elicitation feature adds a second
  // approval layer that Jingler does not own, so configured connectors can
  // still pause with an unhandled approval even when this list is empty.
  // Disable only that duplicate tool-call gate; ordinary MCP form/URL
  // elicitations remain on their separate protocol path.
  const overrides: string[] = ["features.tool_call_mcp_elicitation=false"]
  const secretEnvironmentNames = new Set<string>()
  for (const entry of servers) {
    overrides.push(`mcp_servers.${entry.name}.url=${JSON.stringify(entry.url)}`)
    for (const [key, value] of Object.entries(entry.headers)) {
      const environmentName = entry.headerEnvironment?.[key]
      if (environmentName !== undefined) secretEnvironmentNames.add(environmentName)
      overrides.push(
        environmentName === undefined
          ? `mcp_servers.${entry.name}.http_headers.${key}=${JSON.stringify(value)}`
          : `mcp_servers.${entry.name}.env_http_headers.${key}=${JSON.stringify(environmentName)}`
      )
    }
  }
  for (const environmentName of secretEnvironmentNames) {
    overrides.push(
      `shell_environment_policy.filters.${environmentName}=${JSON.stringify("exclude")}`
    )
  }
  return overrides
}

const configRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}

const codexKey = (value: string): string =>
  /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)

/**
 * Disable harness-native MCPs and browser plugins discovered in Codex TOML.
 * Attached names are excluded because the later launch overrides own them.
 * Malformed/unreadable config documents are ignored; they must never prevent a run.
 */
export const codexManagedToolOverrides = (
  configDocuments: ReadonlyArray<string>,
  attached: ReadonlyArray<RemoteMcpServer> | null | undefined
): ReadonlyArray<string> => {
  const attachedNames = new Set(uniqueRemoteMcpServers(attached).map((entry) => entry.name))
  const nativeMcpNames = new Set<string>()
  const nativeBrowserPlugins = new Set<string>()
  for (const document of configDocuments) {
    try {
      const parsed = configRecord(parse(document))
      for (const name of Object.keys(configRecord(parsed.mcp_servers))) {
        if (!attachedNames.has(name)) nativeMcpNames.add(name)
      }
      for (const name of Object.keys(configRecord(parsed.plugins))) {
        if (/browser|playwright/i.test(name)) nativeBrowserPlugins.add(name)
      }
    } catch {
      // Codex owns validation of its config. Strict precedence is best-effort if
      // an unrelated malformed document exists, rather than a launch blocker.
    }
  }
  return [
    ...[...nativeMcpNames]
      .sort()
      .map((name) => `mcp_servers.${codexKey(name)}.enabled=false`),
    ...[...nativeBrowserPlugins]
      .sort()
      .map((name) => `plugins.${codexKey(name)}.enabled=false`)
  ]
}

/** Native opencode MCPs to disconnect before registering Jingler's managed set. */
export const unmanagedOpencodeMcpNames = (
  status: Readonly<Record<string, unknown>>,
  attached: ReadonlyArray<RemoteMcpServer> | null | undefined
): ReadonlyArray<string> => {
  const managed = new Set(uniqueRemoteMcpServers(attached).map((entry) => entry.name))
  return Object.keys(status)
    .filter((name) => !managed.has(name))
    .sort()
}

/**
 * Secret environment variables referenced by `codexMcpOverrides`. The
 * environment exists only for this app-server process and keeps bearer values
 * out of command-line arguments.
 */
export const codexMcpEnvironment = (
  entries: ReadonlyArray<RemoteMcpServer> | null | undefined
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    uniqueRemoteMcpServers(entries).flatMap((entry) =>
      Object.entries(entry.headerEnvironment ?? {}).flatMap(
        ([header, environmentName]) => {
          const value = entry.headers[header]
          return value === undefined ? [] : [[environmentName, value] as const]
        }
      )
    )
  )

export interface OpencodeMcpEntry {
  readonly name: string
  readonly config: {
    readonly type: "remote"
    readonly url: string
    readonly enabled: true
    readonly headers?: Readonly<Record<string, string>>
  }
}

/**
 * OpenCode remote MCP registrations for its authenticated, process-local API.
 * They are added after startup so bearer values never enter the child process's
 * inheritable `OPENCODE_CONFIG_CONTENT` environment.
 */
export const opencodeMcpEntries = (
  entries: ReadonlyArray<RemoteMcpServer> | null | undefined
): ReadonlyArray<OpencodeMcpEntry> =>
  uniqueRemoteMcpServers(entries).map((entry) => ({
    name: entry.name,
    config: {
      type: "remote",
      url: entry.url,
      enabled: true,
      ...(Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {})
    }
  }))
