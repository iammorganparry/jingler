import type { CliKind, McpServer, OpenConnectorConfig } from "@starbase/core"
import { OPEN_CONNECTOR_DEFAULT } from "@starbase/core"
import { Effect } from "effect"
import { ConfigService } from "./config.js"
import { SecretStore } from "./secret-store.js"
import type { ParsedMcpServer } from "./mcp-config.js"
import { normalizeEndpoint } from "./mcp-config.js"
import { probeServer } from "./mcp-probe.js"

/**
 * The unified MCP source: one self-hosted OpenConnector instance every agent
 * (`claude` / `codex` / `cursor` / `opencode`) is pointed at, so a provider
 * connected once is available to all of them.
 *
 * This is the INVERSE of `McpService`, which only READS each harness's own MCP
 * config for display. Here Starbase OWNS a server and injects it at spawn. The
 * two share the `ParsedMcpServer` split so injection reuses the same redaction
 * contract: the `.server` half (header NAMES only) is all that may cross the RPC
 * boundary; the `.launch` half carries the bearer and never leaves main.
 *
 * The endpoint + toggles live in `WorkspaceConfig.openConnector` (via
 * `ConfigService`); the bearer token lives in `SecretStore` (a sibling of the
 * sign-in `auth.enc`), joined in only at `injection`/`test`.
 */

/** The header the bearer is sent under. A constant so redaction + injection agree. */
const AUTH_HEADER = "Authorization"

/** The `/mcp` endpoint URL for a base, via the shared endpoint normaliser. */
const mcpUrl = (endpoint: string): string => `${normalizeEndpoint(endpoint)}/mcp`

/**
 * Build both halves of the injectable server from config + token. The redacted
 * `target` is the bare `${endpoint}/mcp` (no query, so nothing secret to leak);
 * the launch half carries the real `Authorization: Bearer …` header.
 */
const remoteEntry = (
  config: OpenConnectorConfig,
  token: string,
  cli: CliKind
): ParsedMcpServer => {
  const url = mcpUrl(config.endpoint)
  // `serverName` is `optionalWith` a default, so the decoded type is a plain string.
  const name = config.serverName
  const server: McpServer = {
    name,
    cli,
    transport: "http",
    scope: "user",
    target: url,
    envKeys: [],
    headerKeys: [AUTH_HEADER],
    enabled: true
  }
  return {
    server,
    launch: {
      transport: "http",
      args: [],
      env: {},
      url,
      headers: { [AUTH_HEADER]: `Bearer ${token}` }
    }
  }
}

export class OpenConnectorService extends Effect.Service<OpenConnectorService>()(
  "@starbase/OpenConnectorService",
  {
    accessors: true,
    // ConfigService + SecretStore are used via ACCESSORS inside the methods, not
    // captured at construction — so this service's own construction stays
    // `R = never` (like every peer service, which only needs NodeContext to build)
    // and can be merged as a bare peer in tests. The ConfigService/SecretStore
    // requirements surface at the METHOD level, where the caller's context (the
    // runtime layer graph, or a test's `mergeAll` outputs) satisfies them.
    effect: Effect.gen(function* () {
      const now = () => new Date().toISOString()

      /** The persisted settings, falling back to the shipped (disabled) default. */
      const get = Effect.gen(function* () {
        const cfg = yield* ConfigService.get()
        const token = yield* (yield* SecretStore).getOpenConnectorToken
        return {
          config: cfg?.openConnector ?? OPEN_CONNECTOR_DEFAULT,
          hasToken: token !== null && token.length > 0
        }
      })

      /**
       * Save the settings and, when a token is supplied, the bearer.
       *
       * `token === undefined` leaves the stored token untouched (the panel omits
       * it unless the operator typed a new one, so a settings-only save never
       * clears the credential); `token === null` or `""` clears it; a non-empty
       * string replaces it.
       */
      const set = (config: OpenConnectorConfig, token?: string | null) =>
        Effect.gen(function* () {
          // Token FIRST: `setOpenConnectorToken` can fail (`SecretStoreUnavailable`),
          // and persisting an `enabled` config before it would leave the feature on
          // with no credential — every request then fails "not configured". If the
          // vault write fails, the config is never touched.
          if (token !== undefined) {
            const secrets = yield* SecretStore
            yield* token === null || token.length === 0
              ? secrets.clearOpenConnectorToken
              : secrets.setOpenConnectorToken(token)
          }
          yield* ConfigService.setOpenConnector(config)
        })

      /**
       * The server to inject for `cli`, or null when the feature is off, disabled
       * for that harness, or the endpoint/token is missing. Callers hand the
       * `.launch` half to the harness and must never send `.server` verbatim if it
       * could carry more than header names (it cannot — see `remoteEntry`).
       */
      const injection = (cli: CliKind) =>
        Effect.gen(function* () {
          const cfg = yield* ConfigService.get()
          const config = cfg?.openConnector
          if (!config?.enabled || config.endpoint.length === 0) return null
          if (config.perCli?.[cli] === false) return null
          const token = yield* (yield* SecretStore).getOpenConnectorToken
          if (token === null || token.length === 0) return null
          return remoteEntry(config, token, cli)
        })

      /**
       * Live probe of the configured endpoint, regardless of the enabled toggles,
       * so the Settings panel's "Test" button works before the operator switches
       * the feature on. Returns a `failed` status (never throws) when unconfigured.
       */
      const test = Effect.gen(function* () {
          const cfg = yield* ConfigService.get()
          const config = cfg?.openConnector
          const token = yield* (yield* SecretStore).getOpenConnectorToken
          if (!config || config.endpoint.length === 0 || token === null || token.length === 0) {
            return {
              name: config?.serverName ?? "open-connector",
              scope: "user" as const,
              state: "failed" as const,
              toolCount: null,
              error: "Set an endpoint and a token before testing.",
              checkedAt: now()
            }
          }
          return yield* probeServer(remoteEntry(config, token, "claude"), null, now)
        })

      return { get, set, injection, test }
    })
  }
) {}
