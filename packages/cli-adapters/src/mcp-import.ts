import type { McpConfigEntry, McpImportOrigin, McpImportSourceId } from "@jingler/core"
import { McpConfigEntry as McpConfigEntrySchema, mcpNameError } from "@jingler/core"
import { execFile } from "node:child_process"
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
  /** Absent means a config file the user wrote. */
  readonly origin?: McpImportOrigin
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

const opencodeOAuth = (value: unknown): Record<string, string> | null => {
  const decoded = decodeUnknownMap(value)
  if (Option.isNone(decoded)) return null
  const clientId = decodeString(decoded.value.clientId ?? decoded.value.client_id)
  const clientSecret = decodeString(decoded.value.clientSecret ?? decoded.value.client_secret)
  const scope = decodeString(decoded.value.scope)
  return {
    type: "oauth",
    ...(Option.isSome(clientId) ? { clientId: clientId.value } : {}),
    ...(Option.isSome(clientSecret) ? { clientSecret: clientSecret.value } : {}),
    ...(Option.isSome(scope) ? { scope: scope.value } : {})
  }
}

/** Parse `opencode.json`, translating its explicit OAuth settings to managed MCP OAuth. */
export const parseOpencodeMcp = (raw: string): ReadonlyArray<McpImportCandidate> => {
  const file = Schema.decodeUnknownOption(OpenCodeFile)(JSON.parse(raw))
  if (Option.isNone(file)) return []
  return Object.entries(file.value.mcp ?? {}).map(([name, entry]) => {
    const decoded = decodeUnknownMap(entry)
    if (Option.isNone(decoded) || !("oauth" in decoded.value)) {
      return candidate("opencode", name, entry)
    }
    const { oauth, ...rest } = decoded.value
    if (oauth === false) return candidate("opencode", name, rest)
    const auth = opencodeOAuth(oauth)
    return auth === null
      ? candidate("opencode", name, null, "Unrecognised OAuth configuration")
      : candidate("opencode", name, { ...rest, auth })
  })
}

const LIST_LINE = /^(.+?): (.*?)(?: \((HTTP|SSE|stdio)\))? - ([✔✓✘✗!⏸⊘]|-)(?: (.*))?$/
const slug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

/**
 * Parse `claude mcp list` text into claude.ai connector and plugin candidates
 * (https://code.claude.com/docs/en/mcp). Lines look like
 * `claude.ai Linear: https://mcp.linear.app/mcp - ! Needs authentication` and
 * `plugin:eng:notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication`.
 * Config-file servers in the same output are skipped (the file parser has them).
 *
 * Imported entries are plain remote URLs with Jingler-managed OAuth; claude.ai
 * tokens are never read. Names are slugged (`claude.ai Linear` → `claude-ai-linear`)
 * with the original kept as `displayName`. `taken` holds names already in
 * `mcp.json`, which a candidate may never overwrite.
 */
const listOrigin = (original: string): McpImportOrigin | null =>
  original.startsWith("claude.ai ") ? "claude.ai" : original.startsWith("plugin:") ? "plugin" : null

const listProblem = (
  target: string,
  kind: string | undefined,
  status: string,
  exists: boolean,
  name: string
): string | null => {
  if (target === "" || /not configured/i.test(status)) return "Not configured — the server has no URL"
  if (!/^https?:\/\//.test(target)) return "Local (stdio) servers can't be imported from the Claude listing"
  if (kind === "SSE") return "SSE servers can't use Jingler's managed sign-in"
  return exists ? `A server named "${name}" already exists` : null
}

export const parseClaudeMcpList = (
  output: string,
  taken: ReadonlySet<string> = new Set()
): ReadonlyArray<McpImportCandidate> => {
  const seen = new Set(taken)
  const out: Array<McpImportCandidate> = []
  for (const line of output.split("\n")) {
    const match = LIST_LINE.exec(line.trim())
    if (match === null) continue
    const [, original = "", rawTarget = "", kind, , status = ""] = match
    const origin = listOrigin(original)
    if (origin === null) continue
    const name = slug(original)
    const target = rawTarget.trim()
    const problem = listProblem(target, kind, status, seen.has(name), name)
    seen.add(name)
    out.push({
      ...candidate(
        "claude",
        name,
        problem === null
          ? { type: "remote", url: target, auth: { type: "oauth" }, displayName: original, enabled: true }
          : null,
        problem
      ),
      origin
    })
  }
  return out
}

const run = (
  binary: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly timeoutMs: number }
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 4_000_000, encoding: "utf8" },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error))
    )
  })

const connectorNote = (problem: string): McpImportCandidate => ({
  name: "claude.ai connectors",
  source: "claude",
  origin: "claude.ai",
  entry: null,
  problem
})

/**
 * Discover claude.ai connectors and plugin MCP servers through the Claude CLI.
 * `claude mcp list` health-checks every server and can take a minute, so call
 * it only on an explicit user action. A missing binary, a logged-out CLI or a
 * timeout yields a single unimportable note instead of an error.
 */
export const discoverClaudeConnectors = async (options: {
  readonly cwd: string
  readonly taken: ReadonlySet<string>
  readonly binary?: string
  readonly timeoutMs?: number
}): Promise<ReadonlyArray<McpImportCandidate>> => {
  const binary = options.binary ?? process.env.JINGLER_CLAUDE_BINARY ?? "claude"
  const notes: Array<McpImportCandidate> = []
  try {
    const status: unknown = JSON.parse(await run(binary, ["auth", "status"], { cwd: options.cwd, timeoutMs: 15_000 }))
    const decoded = decodeUnknownMap(status)
    if (Option.isSome(decoded) && decoded.value.loggedIn !== true) {
      notes.push(connectorNote("Claude CLI is signed out — run `claude auth login` to see claude.ai connectors"))
    } else if (Option.isSome(decoded) && decoded.value.authMethod !== "claude.ai") {
      notes.push(connectorNote("claude.ai connectors need a claude.ai login, not an API key"))
    }
  } catch (cause) {
    if (isMissingBinary(cause)) {
      return [connectorNote(`Claude CLI not found (${binary}) — install it to import claude.ai connectors`)]
    }
    // `auth status` is advisory; the listing below is the source of truth.
  }
  try {
    const output = await run(binary, ["mcp", "list"], { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 90_000 })
    return [...notes, ...parseClaudeMcpList(output, options.taken)]
  } catch (cause) {
    return [
      ...notes,
      connectorNote(
        isMissingBinary(cause)
          ? `Claude CLI not found (${binary}) — install it to import claude.ai connectors`
          : "`claude mcp list` failed or timed out — try again"
      )
    ]
  }
}

const isMissingBinary = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
