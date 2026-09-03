import type { McpConfigEntry, McpImportSourceId } from "@jingler/core"
import { McpConfigEntry as McpConfigEntrySchema, mcpNameError } from "@jingler/core"
import { Either, Schema } from "effect"
import { parse as parseToml } from "smol-toml"

/**
 * Pure parsers that read other tools' MCP configs into `McpConfigEntry`
 * candidates. The caller (Settings) shows candidates for confirmation before
 * writing any of them into `~/jingler/mcp.json`.
 *
 * Values are copied as-is — including literal secrets those files already hold
 * in plaintext. A candidate whose name is reserved or malformed carries the
 * problem instead of an entry, so the UI can show why it can't be imported.
 */

export interface McpImportCandidate {
  readonly name: string
  readonly source: McpImportSourceId
  readonly entry: McpConfigEntry | null
  /** Why this candidate cannot be imported; null when `entry` is usable. */
  readonly problem: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringRecord = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string"
        )
      )
    : {}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const candidate = (
  source: McpImportSourceId,
  name: string,
  entry: unknown,
  problem: string | null = null
): McpImportCandidate => {
  const nameProblem = mcpNameError(name)
  if (nameProblem !== null) return { name, source, entry: null, problem: nameProblem }
  if (entry === null) {
    return { name, source, entry, problem: problem ?? "Invalid server configuration" }
  }
  const decoded = Schema.decodeUnknownEither(McpConfigEntrySchema)(entry)
  return Either.isRight(decoded)
    ? { name, source, entry: decoded.right, problem }
    : { name, source, entry: null, problem: "Invalid server configuration" }
}

/** One Claude-shaped `mcpServers` value → our entry. */
const claudeEntry = (raw: Record<string, unknown>): McpConfigEntry | null => {
  const type = typeof raw.type === "string" ? raw.type : undefined
  if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "sse")) {
    return {
      type: "remote",
      url: raw.url,
      ...(type === "sse" ? { transport: "sse" as const } : {}),
      headers: stringRecord(raw.headers),
      enabled: true
    }
  }
  if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
    return {
      type: "local",
      command: [raw.command, ...stringArray(raw.args)],
      environment: stringRecord(raw.env),
      enabled: true
    }
  }
  return null
}

const claudeServers = (
  servers: unknown,
  out: Map<string, McpImportCandidate>
): void => {
  if (!isRecord(servers)) return
  for (const [name, raw] of Object.entries(servers)) {
    if (out.has(name) || !isRecord(raw)) continue
    const entry = claudeEntry(raw)
    out.set(
      name,
      candidate("claude", name, entry, entry === null ? "Unrecognised server shape" : null)
    )
  }
}

/**
 * Parse Claude-shaped JSON: `~/.claude.json` (top-level `mcpServers` plus
 * per-project `projects[path].mcpServers`), repo `.mcp.json`, and Claude
 * Desktop's `claude_desktop_config.json` all share the `mcpServers` record.
 */
export const parseClaudeMcp = (raw: string): ReadonlyArray<McpImportCandidate> => {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) return []
  const out = new Map<string, McpImportCandidate>()
  claudeServers(parsed.mcpServers, out)
  if (isRecord(parsed.projects)) {
    for (const project of Object.values(parsed.projects)) {
      if (isRecord(project)) claudeServers(project.mcpServers, out)
    }
  }
  return [...out.values()]
}

/**
 * Parse `~/.codex/config.toml` `[mcp_servers.<name>]` tables. Local servers
 * carry `command`/`args`/`env`; remote ones carry `url` plus optional
 * `http_headers` and `bearer_token_env_var` — the latter maps onto our
 * `{env:VAR}` placeholder so the token itself never enters the file.
 */
export const parseCodexMcp = (raw: string): ReadonlyArray<McpImportCandidate> => {
  const parsed: unknown = parseToml(raw)
  if (!isRecord(parsed) || !isRecord(parsed.mcp_servers)) return []
  const out: McpImportCandidate[] = []
  for (const [name, server] of Object.entries(parsed.mcp_servers)) {
    if (!isRecord(server)) continue
    const enabled = server.enabled !== false
    if (typeof server.url === "string") {
      const headers = stringRecord(server.http_headers)
      const bearerVar = typeof server.bearer_token_env_var === "string"
        ? server.bearer_token_env_var
        : null
      out.push(candidate("codex", name, {
        type: "remote",
        url: server.url,
        headers: bearerVar === null
          ? headers
          : { ...headers, Authorization: `Bearer {env:${bearerVar}}` },
        enabled
      }))
      continue
    }
    if (typeof server.command === "string") {
      out.push(candidate("codex", name, {
        type: "local",
        command: [server.command, ...stringArray(server.args)],
        environment: stringRecord(server.env),
        enabled
      }))
      continue
    }
    out.push(candidate("codex", name, null, "Unrecognised server shape"))
  }
  return out
}

/** Parse `opencode.json`; unsupported OAuth entries stay visible but cannot import. */
export const parseOpencodeMcp = (raw: string): ReadonlyArray<McpImportCandidate> => {
  const file: unknown = JSON.parse(raw)
  if (!isRecord(file) || !isRecord(file.mcp)) return []
  return Object.entries(file.mcp).map(([name, entry]) =>
    isRecord(entry) && "oauth" in entry
      ? candidate("opencode", name, null, "OAuth servers are not supported")
      : candidate("opencode", name, entry)
  )
}
