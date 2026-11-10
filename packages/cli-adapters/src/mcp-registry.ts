import { McpConfigEntry as McpConfigEntrySchema, type McpConfigEntry, type McpRegistryEntry } from "@jingler/core"
import { Either, Schema } from "effect"

/** https://registry.modelcontextprotocol.io — `GET /v0.1/servers` (verified 2026-11). */
const REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers"

const Variable = Schema.Struct({
  name: Schema.String,
  isRequired: Schema.optional(Schema.Boolean)
})
const Remote = Schema.Struct({
  type: Schema.String,
  url: Schema.String,
  headers: Schema.optional(Schema.Array(Variable))
})
const Package = Schema.Struct({
  registryType: Schema.String,
  identifier: Schema.String,
  version: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.Struct({ type: Schema.String })),
  environmentVariables: Schema.optional(Schema.Array(Variable))
})
const RegistryServer = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  icons: Schema.optional(Schema.Array(Schema.Struct({ src: Schema.String }))),
  remotes: Schema.optional(Schema.Array(Remote)),
  packages: Schema.optional(Schema.Array(Package))
})
const RegistryResponse = Schema.Struct({
  servers: Schema.Array(Schema.Struct({ server: Schema.Unknown }))
})
type RegistryServer = Schema.Schema.Type<typeof RegistryServer>

const RUNNERS: Readonly<Record<string, string>> = { npm: "npx", pypi: "uvx" }
const PIN: Readonly<Record<string, string>> = { npm: "@", pypi: "==" }

/** Pin to the published version so a later (possibly compromised) release isn't picked up silently. */
const pinned = (pkg: { readonly registryType: string; readonly identifier: string; readonly version?: string | undefined }): string =>
  pkg.version === undefined || pkg.version === "latest" ? pkg.identifier : `${pkg.identifier}${PIN[pkg.registryType]}${pkg.version}`

/** `io.github.owner/linear-mcp` → `linear-mcp`; always a valid mcp.json name. */
export const registrySlug = (name: string): string =>
  (name.split("/").pop() ?? name).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 64) || "server"

const https = (value: string): string | undefined => {
  try {
    return new URL(value).protocol === "https:" ? value : undefined
  } catch {
    return undefined
  }
}

/** Remote first (no install, OAuth via Jingler), then an npm/pypi stdio package. */
const toEntry = (server: RegistryServer): { entry: McpConfigEntry | null; kind: string; problem: string | null } => {
  const displayName = (server.title ?? registrySlug(server.name)).slice(0, 128)
  const iconUrl = server.icons?.map(({ src }) => https(src)).find((src) => src !== undefined)
  const meta = { displayName, ...(iconUrl === undefined ? {} : { iconUrl }) }
  const remote = server.remotes?.find((candidate) =>
    candidate.type === "streamable-http" && !(candidate.headers ?? []).some((header) => header.isRequired === true)
  )
  if (remote !== undefined) {
    return { kind: "Remote", problem: null, entry: { type: "remote", url: remote.url, headers: {}, enabled: true, ...meta } }
  }
  const pkg = server.packages?.find((candidate) =>
    RUNNERS[candidate.registryType] !== undefined && (candidate.transport?.type ?? "stdio") === "stdio"
  )
  if (pkg !== undefined) {
    const runner = RUNNERS[pkg.registryType]!
    // Values stay `{env:VAR}` placeholders: secrets are never written into mcp.json.
    const environment = Object.fromEntries((pkg.environmentVariables ?? []).map(({ name }) => [name, `{env:${name}}`]))
    return {
      kind: `Local · ${runner}`,
      problem: null,
      entry: { type: "local", command: runner === "npx" ? ["npx", "-y", pinned(pkg)] : [runner, pinned(pkg)], environment, enabled: true, ...meta }
    }
  }
  return { kind: server.remotes?.length ? "Remote" : "Package", entry: null, problem: "Needs headers or a runtime Jingler can't set up yet" }
}

/** Decode one registry page; entries that fail the mcp.json schema become unaddable with a reason. */
export const parseMcpRegistry = (body: unknown): ReadonlyArray<McpRegistryEntry> => {
  const page = Schema.decodeUnknownEither(RegistryResponse)(body)
  if (Either.isLeft(page)) return []
  const seen = new Set<string>()
  return page.right.servers.flatMap(({ server: raw }) => {
    const decoded = Schema.decodeUnknownEither(RegistryServer)(raw)
    if (Either.isLeft(decoded) || seen.has(decoded.right.name)) return []
    const server = decoded.right
    seen.add(server.name)
    const mapped = toEntry(server)
    const valid = mapped.entry !== null && Either.isRight(Schema.decodeUnknownEither(McpConfigEntrySchema)(mapped.entry))
    return [{
      registryName: server.name,
      name: registrySlug(server.name),
      displayName: mapped.entry?.displayName ?? server.title ?? registrySlug(server.name),
      description: server.description ?? "",
      iconUrl: mapped.entry?.iconUrl ?? null,
      kind: mapped.kind,
      entry: valid ? mapped.entry : null,
      problem: valid ? null : (mapped.problem ?? "Invalid server configuration")
    }]
  })
}

export const searchMcpRegistry = async (
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReadonlyArray<McpRegistryEntry>> => {
  // E2E only: main sets JINGLER_E2E and points this at a local fake registry.
  const base = process.env.JINGLER_E2E === "1" ? (process.env.JINGLER_MCP_REGISTRY_URL ?? REGISTRY) : REGISTRY
  const url = new URL(base)
  url.searchParams.set("version", "latest")
  url.searchParams.set("limit", "40")
  if (query.trim() !== "") url.searchParams.set("search", query.trim())
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`MCP registry answered ${response.status}`)
  return parseMcpRegistry(await response.json())
}
