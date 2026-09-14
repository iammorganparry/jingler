import { Schema } from "effect"

/**
 * Renderer-safe metadata for an MCP server managed by Jingler.
 */

/** How a server is reached. `stdio` spawns a command; the rest are remote URLs. */
export const McpTransport = Schema.Literal("stdio", "http", "sse")
export type McpTransport = Schema.Schema.Type<typeof McpTransport>

/**
 * Which config file a server came from, in ascending precedence.
 *
 * - `user` — the operator's global config (e.g. `~/.claude.json`, `~/.codex/config.toml`).
 * - `project` — committed to the repo (e.g. `<root>/.mcp.json`, `<root>/.cursor/mcp.json`).
 * - `local` — this machine's per-project overrides (`~/.claude.json` → `projects[<path>]`).
 */
export const McpScope = Schema.Literal("user", "project", "local")
export type McpScope = Schema.Schema.Type<typeof McpScope>

/**
 * The result of probing a server.
 *
 * `unknown` means configured but not yet contacted. Distinct from an absent
 * status, which means no probe result exists.
 */
export const McpServerState = Schema.Literal(
  "unknown",
  "connected",
  "needs-auth",
  "authorizing",
  "failed",
  "disabled"
)
export type McpServerState = Schema.Schema.Type<typeof McpServerState>

export const McpAuthKind = Schema.Literal("none", "api-key", "oauth")
export type McpAuthKind = Schema.Schema.Type<typeof McpAuthKind>
export const McpAuthState = Schema.Literal("not-required", "ready", "needs-auth", "authorizing")
export type McpAuthState = Schema.Schema.Type<typeof McpAuthState>

/**
 * One configured MCP server.
 *
 * SECURITY: this type is the redaction contract. Real configs carry API keys in
 * `env` and `http_headers` (see `~/.codex/config.toml`), so this struct carries
 * only *names* — `envKeys`, `headerKeys` — and never a value. Leaking a secret to
 * the renderer would require changing this schema, which is the point.
 */
export const McpServer = Schema.Struct({
  /** Stable runtime name, e.g. "linear". */
  name: Schema.String,
  displayName: Schema.String,
  /** Optional HTTPS artwork URL. The UI always has a monogram fallback. */
  iconUrl: Schema.NullOr(Schema.String),
  authKind: McpAuthKind,
  authState: McpAuthState,
  transport: McpTransport,
  scope: McpScope,
  /**
   * Display-only summary of where the server lives: the command for `stdio`
   * (argv joined), or the URL for a remote one. Never contains env or headers.
   */
  target: Schema.String,
  /** Names of env vars the server is given. Values are deliberately absent. */
  envKeys: Schema.Array(Schema.String),
  /** Names of HTTP headers sent to a remote server. Values are deliberately absent. */
  headerKeys: Schema.Array(Schema.String),
  /** False when the operator disabled the managed server. */
  enabled: Schema.Boolean
})
export type McpServer = Schema.Schema.Type<typeof McpServer>

/** The outcome of a live probe against one server. */
export const McpServerStatus = Schema.Struct({
  /** Matches `McpServer.name`. */
  name: Schema.String,
  scope: McpScope,
  state: McpServerState,
  /** Tools reported by `tools/list`; null unless the probe connected. */
  toolCount: Schema.NullOr(Schema.Number),
  /** Why the probe failed, for the dialog. Null when it didn't. */
  error: Schema.NullOr(Schema.String),
  /** ISO-8601 timestamp of the probe, so the dialog can show "checked 2m ago". */
  checkedAt: Schema.String
})
export type McpServerStatus = Schema.Schema.Type<typeof McpServerStatus>

/** Secret-bearing renderer input. This type is accepted by RPC and never returned. */
export const SetMcpApiKeyInput = Schema.Struct({
  name: Schema.String,
  apiKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536))
})
export type SetMcpApiKeyInput = Schema.Schema.Type<typeof SetMcpApiKeyInput>

export const McpAuthorizationStart = Schema.Struct({
  authorizationUrl: Schema.String,
  state: McpServerState
})
export type McpAuthorizationStart = Schema.Schema.Type<typeof McpAuthorizationStart>

/** Stable identity for a server across list/status/cache — name alone can collide across scopes. */
export const mcpServerKey = (scope: McpScope, name: string): string => `${scope}:${name}`
