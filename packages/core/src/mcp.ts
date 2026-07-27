import { Schema } from "effect"
import { CliKind } from "./domain.js"

/**
 * MCP (Model Context Protocol) servers, as configured in the *harness's own*
 * config files. Jingler never defines an MCP format of its own — it reads what
 * `claude` / `codex` / `cursor` / `opencode` already load, and reports it back.
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
 * `unknown` means "configured, deliberately not contacted" — a project-scope server
 * from a harness that gates project config behind its own consent prompt, which we
 * must not spawn on the operator's behalf. Distinct from an absent status, which
 * just means nothing has been probed yet.
 */
export const McpServerState = Schema.Literal("unknown", "connected", "failed", "disabled")
export type McpServerState = Schema.Schema.Type<typeof McpServerState>

/**
 * One configured MCP server.
 *
 * SECURITY: this type is the redaction contract. Real configs carry API keys in
 * `env` and `http_headers` (see `~/.codex/config.toml`), so this struct carries
 * only *names* — `envKeys`, `headerKeys` — and never a value. Leaking a secret to
 * the renderer would require changing this schema, which is the point.
 */
export const McpServer = Schema.Struct({
  /** The key the harness knows this server by, e.g. "linear". */
  name: Schema.String,
  /** Which harness's config this came from. */
  cli: CliKind,
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
  /** False when the harness's config explicitly disables/does not approve it. */
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

/**
 * Why a harness is not receiving the unified server. `null` on an injected target.
 *
 * These are the four ways "connected in Settings" fails to mean "the agent has the
 * tools", and they are indistinguishable from the config alone — which is exactly
 * why the UI asks the resolver rather than re-deriving them.
 */
export const McpInjectionSkip = Schema.Literal(
  /** The master switch is off, or no endpoint is set. */
  "disabled",
  /** `perCli[<harness>] === false` — this harness was opted out. */
  "opted-out",
  /** No bearer token is stored, so no request could authenticate. */
  "no-token",
  /** Jingler has no run path for this harness, so there is nothing to inject into. */
  "no-run-path"
)
export type McpInjectionSkip = Schema.Schema.Type<typeof McpInjectionSkip>

/**
 * What ONE harness would actually be launched with, resolved through the same
 * `OpenConnectorService.injection(cli)` the agent runner calls.
 *
 * SECURITY: `url` is the bare `${endpoint}/mcp` and `headerKeys` carries header
 * NAMES only — the bearer never crosses the RPC boundary, matching `McpServer`.
 */
export const McpInjectionTarget = Schema.Struct({
  cli: CliKind,
  /** The name the server is registered under in that harness's config. */
  serverName: Schema.String,
  /** True when a session on this harness starts with the unified server attached. */
  injected: Schema.Boolean,
  /** `${endpoint}/mcp`, or null when nothing would be injected. */
  url: Schema.NullOr(Schema.String),
  /** Header names sent to the instance (values deliberately absent). */
  headerKeys: Schema.Array(Schema.String),
  /** Why not, when `injected` is false. Null when it is. */
  skipped: Schema.NullOr(McpInjectionSkip)
})
export type McpInjectionTarget = Schema.Schema.Type<typeof McpInjectionTarget>

/** Stable identity for a server across list/status/cache — name alone can collide across scopes. */
export const mcpServerKey = (scope: McpScope, name: string): string => `${scope}:${name}`
