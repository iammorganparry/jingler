import type { McpConfigEntry, McpImportSourceId } from "@jingler/core"
import { McpConfigEntry as McpConfigEntrySchema, mcpNameError } from "@jingler/core"
import { Either, Option, Schema } from "effect"
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

const UnknownMap = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const decodeUnknownMap = Schema.decodeUnknownOption(UnknownMap)
const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeBoolean = Schema.decodeUnknownOption(Schema.Boolean)

const stringRecord = (value: unknown): Record<string, string> => {
  const record = decodeUnknownMap(value)
  if (Option.isNone(record)) return {}
  const strings: Record<string, string> = {}
  for (const [key, value] of Object.entries(record.value)) {
    const decoded = decodeString(value)
    if (Option.isSome(decoded)) strings[key] = decoded.value
  }
  return strings
}

const stringArray = (value: unknown): ReadonlyArray<string> => {
  const values = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(value)
  return Option.isNone(values) ? [] : values.value.filter(Schema.is(Schema.String))
}

const ClaudeFile = Schema.Struct({
  mcpServers: Schema.optional(Schema.Unknown),
  projects: Schema.optional(Schema.Unknown)
})
const ClaudeProject = Schema.Struct({ mcpServers: Schema.optional(Schema.Unknown) })
const ClaudeRemote = Schema.Struct({
  url: Schema.String,
  type: Schema.optional(Schema.Unknown),
  headers: Schema.optional(Schema.Unknown)
})
const ClaudeLocal = Schema.Struct({
  command: Schema.String,
  type: Schema.optional(Schema.Unknown),
  args: Schema.optional(Schema.Unknown),
  env: Schema.optional(Schema.Unknown)
})
const OpenCodeFile = Schema.Struct({ mcp: Schema.optional(UnknownMap) })
const CodexServer = Schema.Struct({
  url: Schema.optional(Schema.Unknown),
  command: Schema.optional(Schema.Unknown),
  enabled: Schema.optional(Schema.Unknown),
  http_headers: Schema.optional(Schema.Unknown),
  bearer_token_env_var: Schema.optional(Schema.Unknown),
  args: Schema.optional(Schema.Unknown),
  env: Schema.optional(Schema.Unknown)
})

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
const claudeEntry = (raw: unknown): McpConfigEntry | null => {
  const remote = Schema.decodeUnknownEither(ClaudeRemote)(raw)
  if (Either.isRight(remote)) {
    const transport = decodeString(remote.right.type)
    if (Option.isNone(transport) || transport.value === "http" || transport.value === "sse") {
      const entry: McpConfigEntry = {
        type: "remote",
        url: remote.right.url,
        headers: stringRecord(remote.right.headers),
        enabled: true
      }
      return Option.isSome(transport) && transport.value === "sse"
        ? { ...entry, transport: "sse" }
        : entry
    }
  }
  const local = Schema.decodeUnknownEither(ClaudeLocal)(raw)
  if (Either.isLeft(local)) return null
  const transport = decodeString(local.right.type)
  return Option.isNone(transport) || transport.value === "stdio"
    ? {
        type: "local",
        command: [local.right.command, ...stringArray(local.right.args)],
        environment: stringRecord(local.right.env),
        enabled: true
      }
    : null
}

const claudeServers = (
  servers: unknown,
  out: Map<string, McpImportCandidate>
): void => {
  const decoded = decodeUnknownMap(servers)
  if (Option.isNone(decoded)) return
  for (const [name, raw] of Object.entries(decoded.value)) {
    if (out.has(name)) continue
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
  const parsed = Schema.decodeUnknownOption(ClaudeFile)(JSON.parse(raw))
  if (Option.isNone(parsed)) return []
  const out = new Map<string, McpImportCandidate>()
  claudeServers(parsed.value.mcpServers, out)
  const projects = decodeUnknownMap(parsed.value.projects)
  if (Option.isSome(projects)) {
    for (const project of Object.values(projects.value)) {
      const decoded = Schema.decodeUnknownOption(ClaudeProject)(project)
      if (Option.isSome(decoded)) claudeServers(decoded.value.mcpServers, out)
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
  const parsed = parseToml(raw)
  const servers = decodeUnknownMap(parsed.mcp_servers)
  if (Option.isNone(servers)) return []
  return Object.entries(servers.value).map(([name, rawServer]) => {
    const decoded = Schema.decodeUnknownEither(CodexServer)(rawServer)
    if (Either.isLeft(decoded)) {
      return candidate("codex", name, null, "Unrecognised server shape")
    }
    const server = decoded.right
    const enabled = Option.getOrElse(decodeBoolean(server.enabled), () => true)
    const url = decodeString(server.url)
    if (Option.isSome(url)) {
      const headers = stringRecord(server.http_headers)
      const bearerVariable = decodeString(server.bearer_token_env_var)
      return candidate("codex", name, {
        type: "remote",
        url: url.value,
        headers: Option.isNone(bearerVariable)
          ? headers
          : { ...headers, Authorization: `Bearer {env:${bearerVariable.value}}` },
        enabled
      })
    }
    const command = decodeString(server.command)
    return Option.isSome(command)
      ? candidate("codex", name, {
          type: "local",
          command: [command.value, ...stringArray(server.args)],
          environment: stringRecord(server.env),
          enabled
        })
      : candidate("codex", name, null, "Unrecognised server shape")
  })
}

/** Parse `opencode.json`, translating its OAuth marker to managed MCP OAuth. */
export const parseOpencodeMcp = (raw: string): ReadonlyArray<McpImportCandidate> => {
  const file = Schema.decodeUnknownOption(OpenCodeFile)(JSON.parse(raw))
  if (Option.isNone(file)) return []
  return Object.entries(file.value.mcp ?? {}).map(([name, entry]) => {
    const decoded = decodeUnknownMap(entry)
    if (Option.isNone(decoded) || !("oauth" in decoded.value)) {
      return candidate("opencode", name, entry)
    }
    const { oauth: _oauth, ...rest } = decoded.value
    return candidate("opencode", name, { ...rest, auth: { type: "oauth" } })
  })
}
