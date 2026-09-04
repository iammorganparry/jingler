import { Schema } from "effect"

/**
 * The operator-editable MCP config, `~/jingler/mcp.json`.
 *
 * The format is deliberately opencode-compatible (https://opencode.ai/docs/mcp-servers/)
 * so supported entries copy across without reshaping.
 *
 * SECURITY: this file may hold literal secrets (headers, env values) — the same
 * stance as opencode's config and `~/.claude.json`. It is read only in the main
 * process and NEVER crosses the RPC boundary; the renderer sees the redacted
 * `McpServer` shape from `mcp.ts`. `{env:VAR}` placeholders are supported so
 * operators can keep the file itself secret-free.
 */

const RemoteMcpUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" && url.password === ""
    } catch {
      return false
    }
  }, { message: () => "MCP URL must be HTTP(S) without embedded credentials" })
)

/** A remote MCP server reached over streamable HTTP (default) or SSE. */
export const McpConfigRemote = Schema.Struct({
  type: Schema.Literal("remote"),
  url: RemoteMcpUrl,
  /** Only needed for legacy SSE servers; absent means streamable HTTP. */
  transport: Schema.optional(Schema.Literal("http", "sse")),
  headers: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { default: () => ({}) }
  ),
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  timeout: Schema.optional(Schema.Number.pipe(Schema.positive()))
})
export type McpConfigRemote = Schema.Schema.Type<typeof McpConfigRemote>

/** A local MCP server spawned as a child process over stdio. */
export const McpConfigLocal = Schema.Struct({
  type: Schema.Literal("local"),
  /** argv: `["npx", "-y", "some-mcp"]`. Never shell-interpreted. */
  command: Schema.Array(Schema.String.pipe(Schema.minLength(1))).pipe(Schema.minItems(1)),
  environment: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { default: () => ({}) }
  ),
  cwd: Schema.optional(Schema.String),
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  timeout: Schema.optional(Schema.Number.pipe(Schema.positive()))
})
export type McpConfigLocal = Schema.Schema.Type<typeof McpConfigLocal>

export const McpConfigEntry = Schema.Union(McpConfigRemote, McpConfigLocal)
export type McpConfigEntry = Schema.Schema.Type<typeof McpConfigEntry>

/** The whole file: `{ "mcp": { "<name>": <entry> } }`. */
export const McpConfigFile = Schema.Struct({
  mcp: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: McpConfigEntry }),
    { default: () => ({}) }
  )
})
export type McpConfigFile = Schema.Schema.Type<typeof McpConfigFile>

/**
 * Names Jingler's internal attachments own. An operator entry with one of
 * these would shadow (or appear to shadow) an internal server in tool
 * prefixes, so they are rejected at validation time.
 */
export const MCP_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "browser",
  "jingler",
  "jingler-browser",
  "memory",
  "permission",
  "plan",
  "question",
  "workspace"
])

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Returns a human-readable problem with the name, or null when it is fine. */
export const mcpNameError = (name: string): string | null => {
  if (!NAME_PATTERN.test(name)) {
    return `MCP name "${name}" must be 1-64 characters of letters, digits, ".", "_" or "-", starting with a letter or digit`
  }
  const normalized = name.toLowerCase()
  if (MCP_RESERVED_NAMES.has(normalized) || normalized.startsWith("jingler-")) {
    return `MCP name "${name}" is reserved by Jingler`
  }
  return null
}

/** Config files Jingler can import MCP servers from. */
export const McpImportSourceId = Schema.Literal("claude", "codex", "opencode")
export type McpImportSourceId = Schema.Schema.Type<typeof McpImportSourceId>

/**
 * Renderer-safe view of one import candidate: name + display target only.
 * Header/env VALUES from the source file never cross the RPC boundary; the
 * actual import re-parses the file in the main process.
 */
export const McpImportCandidateView = Schema.Struct({
  name: Schema.String,
  source: McpImportSourceId,
  /** Display summary — the URL or argv. */
  target: Schema.String,
  /** Why this candidate cannot be imported; null when it can. */
  problem: Schema.NullOr(Schema.String)
})
export type McpImportCandidateView = Schema.Schema.Type<typeof McpImportCandidateView>

const PLACEHOLDER = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Replace every `{env:VAR}` placeholder; missing variables become empty strings. */
export const interpolateEnv = (
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string => value.replace(PLACEHOLDER, (_, name: string) => env[name] ?? "")

/** Interpolate every value of a headers/environment record. */
export const interpolateEnvRecord = (
  record: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, interpolateEnv(value, env)])
  )
