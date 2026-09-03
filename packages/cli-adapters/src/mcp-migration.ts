import { FileSystem } from "@effect/platform"
import type { McpConfigEntry } from "@jingler/core"
import { ManagedMcpServer, mcpNameError } from "@jingler/core"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { McpConfigService } from "./mcp-config-service.js"
import { AgentSecretStore } from "./runtime/auth/agent-secret-store.js"
import { SecretStore } from "./secret-store.js"

/**
 * One-time startup migration into `~/jingler/mcp.json`:
 *
 * 1. An enabled OpenConnector config (`config.json` + its SecretStore bearer)
 *    becomes a remote entry.
 * 2. Imported managed MCP servers (`agent-resources/mcp.json` + encrypted
 *    values) become plain entries, secrets decrypted into the file — mcp.json
 *    is the single catalog and is main-process-only.
 *
 * Guarded on `mcp.json` not existing yet, so it runs at most once and never
 * touches a file the operator already owns. Best-effort: any failure logs and
 * leaves the app fully usable.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const decodeCatalog = Schema.decodeUnknownEither(Schema.parseJson(Schema.Array(ManagedMcpServer)))

/**
 * Read `openConnector` from the RAW config.json — the key may already be gone
 * from the `WorkspaceConfig` schema, so this cannot go through `ConfigService`.
 */
const openConnectorEntry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* AppPaths
  const secrets = yield* SecretStore
  const raw = yield* fs.readFileString(paths.configFile).pipe(Effect.orElseSucceed(() => null))
  if (raw === null) return null
  const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown).pipe(
    Effect.orElseSucceed(() => null)
  )
  if (!isRecord(parsed) || !isRecord(parsed.openConnector)) return null
  const { endpoint, enabled, serverName } = parsed.openConnector
  if (enabled !== true || typeof endpoint !== "string" || endpoint.length === 0) return null
  const token = yield* secrets.getOpenConnectorToken
  if (token === null || token.length === 0) return null
  const name = typeof serverName === "string" && mcpNameError(serverName) === null
    ? serverName
    : "open-connector"
  const entry: McpConfigEntry = {
    type: "remote",
    url: `${endpoint.replace(/\/+$/, "")}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    enabled: true
  }
  return { name, entry }
})

const importedEntries = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* AppPaths
  const secretStore = yield* SecretStore
  const secrets = new AgentSecretStore(secretStore)
  const raw = yield* fs.readFileString(paths.importedMcpFile).pipe(Effect.orElseSucceed(() => null))
  if (raw === null) return []
  const catalog = decodeCatalog(raw)
  if (catalog._tag === "Left") return []
  const entries: Array<{
    readonly name: string
    readonly entry: McpConfigEntry
    readonly targetId: string
  }> = []
  for (const server of catalog.right) {
    const secret = yield* secrets
      .readMcp(server.id, server.availability.targetId)
      .pipe(Effect.orElseSucceed(() => null))
    const entry: McpConfigEntry = server.transport === "stdio"
      ? {
          type: "local",
          command: [server.command, ...server.args],
          environment: secret?.env ?? {},
          enabled: server.enabled
        }
      : {
          type: "remote",
          url: server.url,
          ...(server.transport === "sse" ? { transport: "sse" as const } : {}),
          headers: secret?.headers ?? {},
          enabled: server.enabled
        }
    if (mcpNameError(server.id) === null) {
      entries.push({ name: server.id, entry, targetId: server.availability.targetId })
    }
  }
  return entries
})

export const migrateMcpConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* AppPaths
  const exists = yield* fs.exists(paths.mcpConfigFile).pipe(Effect.orElseSucceed(() => false))
  if (exists) return
  const connector = yield* openConnectorEntry
  const imported = yield* importedEntries
  const entries = [...(connector === null ? [] : [connector]), ...imported]
  if (entries.length === 0) return
  for (const { name, entry } of entries) {
    yield* McpConfigService.write(name, entry)
  }
  // The old stores are now duplicates of mcp.json; leaving them would re-run
  // this migration's sources against an operator-edited file forever.
  yield* fs.remove(paths.importedMcpFile).pipe(Effect.ignore)
  const secretStore = yield* SecretStore
  const agentSecrets = new AgentSecretStore(secretStore)
  yield* Effect.forEach(
    imported,
    ({ name, targetId }) => agentSecrets.deleteMcp(name, targetId).pipe(Effect.ignore),
    { discard: true }
  )
  yield* secretStore.clearOpenConnectorToken.pipe(Effect.ignore)
}).pipe(
  Effect.provide(McpConfigService.Default),
  Effect.catchAll((cause) =>
    Effect.logWarning(`MCP config migration skipped: ${String(cause)}`)
  )
)
