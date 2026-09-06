import { FileSystem } from "@effect/platform"
import type { McpConfigEntry } from "@jingler/core"
import { ManagedResourceId, mcpNameError } from "@jingler/core"
import { Effect, Schema } from "effect"
import { AppPaths, type AppPathsShape } from "./app-paths.js"
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
 * Guarded on `mcp.json` not existing, so it never touches a file the operator
 * already owns. With nothing to migrate it is a cheap no-op on later starts.
 * Best-effort: any failure logs and
 * leaves the app fully usable.
 */

const LegacyOpenConnectorConfig = Schema.Struct({
  openConnector: Schema.optional(Schema.Struct({
    endpoint: Schema.String.pipe(Schema.minLength(1)),
    enabled: Schema.Boolean,
    serverName: Schema.optional(Schema.String)
  }))
})
const decodeLegacyConfig = Schema.decodeUnknown(Schema.parseJson(LegacyOpenConnectorConfig))

const LegacyManagedMcpServer = Schema.Union(
  Schema.Struct({
    id: ManagedResourceId,
    name: Schema.String,
    enabled: Schema.Boolean,
    availability: Schema.Struct({ targetId: Schema.String }),
    transport: Schema.Literal("http", "sse"),
    url: Schema.String,
    headerKeys: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    id: ManagedResourceId,
    name: Schema.String,
    enabled: Schema.Boolean,
    availability: Schema.Struct({ targetId: Schema.String }),
    transport: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    envKeys: Schema.Array(Schema.String)
  })
)
const decodeCatalog = Schema.decodeUnknownEither(
  Schema.parseJson(Schema.Array(LegacyManagedMcpServer))
)

/**
 * Read `openConnector` from the RAW config.json — the key may already be gone
 * from the `WorkspaceConfig` schema, so this cannot go through `ConfigService`.
 */
const openConnectorEntry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* AppPaths
  const secrets = yield* SecretStore
  if (!(yield* fs.exists(paths.configFile))) return null
  const raw = yield* fs.readFileString(paths.configFile)
  const { openConnector } = yield* decodeLegacyConfig(raw)
  if (openConnector === undefined || !openConnector.enabled) return null
  const token = yield* secrets.getOpenConnectorToken
  if (token === null || token.length === 0) return null
  const name = openConnector.serverName !== undefined && mcpNameError(openConnector.serverName) === null
    ? openConnector.serverName
    : "open-connector"
  const entry: McpConfigEntry = {
    type: "remote",
    url: `${openConnector.endpoint.replace(/\/+$/, "")}/mcp`,
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
  if (!(yield* fs.exists(paths.importedMcpFile))) return []
  return yield* readLegacyMcpEntries(fs, paths, secrets)
})

export const migrateMcpConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* AppPaths
  const exists = yield* fs.exists(paths.mcpConfigFile)
  if (exists) return
  const connector = yield* openConnectorEntry
  const imported = yield* importedEntries
  const entries = [...(connector === null ? [] : [connector]), ...imported]
  if (entries.length === 0) return
  const names = entries.map(({ name }) => name)
  if (new Set(names).size !== names.length) {
    return yield* Effect.fail(new Error("Legacy MCP sources contain duplicate server names"))
  }
  yield* McpConfigService.writeAll(
    Object.fromEntries(entries.map(({ name, entry }) => [name, entry]))
  )
  // The old stores are now duplicates of mcp.json; leaving them would re-run
  // this migration's sources against an operator-edited file forever.
  yield* fs.remove(paths.importedMcpFile).pipe(Effect.ignore)
  const secretStore = yield* SecretStore
  const agentSecrets = new AgentSecretStore(secretStore)
  yield* Effect.forEach(
    imported,
    ({ resourceId, targetId }) => agentSecrets.deleteMcp(resourceId, targetId).pipe(Effect.ignore),
    { discard: true }
  )
  if (connector !== null) {
    yield* secretStore.clearOpenConnectorToken.pipe(Effect.ignore)
  }
}).pipe(
  Effect.provide(McpConfigService.Default),
  Effect.catchAll((cause) =>
    Effect.logWarning(`MCP config migration skipped: ${String(cause)}`)
  )
)

function* readLegacyMcpEntries(
  fs: FileSystem.FileSystem,
  paths: AppPathsShape,
  secrets: AgentSecretStore
) {
  const raw = yield* fs.readFileString(paths.importedMcpFile)
  const catalog = decodeCatalog(raw)
  if (catalog._tag === "Left") {
    return yield* Effect.fail(new Error("Legacy MCP catalog is malformed"))
  }
  const entries: Array<{
    readonly name: string
    readonly resourceId: string
    readonly entry: McpConfigEntry
    readonly targetId: string
  }> = []
  for (const server of catalog.right) {
    const secret = yield* secrets.readMcp(server.id, server.availability.targetId)
    const secretKeys = server.transport === "stdio" ? server.envKeys : server.headerKeys
    const secretValues = (server.transport === "stdio" ? secret?.env : secret?.headers) ?? {}
    if (secretKeys.some((key) => !Object.hasOwn(secretValues, key))) {
      return yield* Effect.fail(new Error(`Could not decrypt MCP secrets for "${server.id}"`))
    }
    const entry: McpConfigEntry = server.transport === "stdio"
      ? {
          type: "local",
          command: [server.command, ...server.args],
          environment: secretValues,
          enabled: server.enabled
        }
      : {
          type: "remote",
          url: server.url,
          transport: server.transport,
          headers: secretValues,
          enabled: server.enabled
        }
    const name = mcpNameError(server.name) === null ? server.name : server.id
    if (mcpNameError(name) !== null) {
      return yield* Effect.fail(new Error(`Legacy MCP server "${server.id}" has no usable name`))
    }
    entries.push({
      name,
      resourceId: server.id,
      entry,
      targetId: server.availability.targetId
    })
  }
  return entries
}
