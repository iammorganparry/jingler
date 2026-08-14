import {
  type ManagedMcpImportInput,
  ManagedMcpServer,
  type ManagedMcpServer as ManagedMcpServerType,
  type ManagedResourceId
} from "@jingler/core"
import { Context, Data, Effect, Exit, PubSub, Schema, Stream } from "effect"
import type {
  AgentSecretStore,
  ManagedMcpSecretPayload
} from "../auth/agent-secret-store.js"
import { AtomicJsonFile } from "../persistence/atomic-json-file.js"

const McpCatalog = Schema.Array(ManagedMcpServer)
const RESERVED_IDS = new Set([
  "browser",
  "jingler",
  "memory",
  "openconnector",
  "permission",
  "plan",
  "question",
  "workspace"
])

export class ImportedMcpError extends Data.TaggedError("ImportedMcpError")<{
  readonly operation: "list" | "import" | "remove" | "enable" | "resolve"
  readonly message: string
}> {}

export type ResolvedManagedMcp =
  | {
      readonly id: ManagedResourceId
      readonly name: string
      readonly transport: "http" | "sse"
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }
  | {
      readonly id: ManagedResourceId
      readonly name: string
      readonly transport: "stdio"
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly env: Readonly<Record<string, string>>
    }

export interface ImportedMcpServiceShape {
  readonly list: Effect.Effect<ReadonlyArray<ManagedMcpServerType>, ImportedMcpError>
  readonly importServer: (
    input: ManagedMcpImportInput
  ) => Effect.Effect<ManagedMcpServerType, ImportedMcpError>
  readonly remove: (id: ManagedResourceId) => Effect.Effect<void, ImportedMcpError>
  readonly setEnabled: (
    id: ManagedResourceId,
    enabled: boolean
  ) => Effect.Effect<void, ImportedMcpError>
  readonly resolveForTarget: (
    targetId: string
  ) => Effect.Effect<ReadonlyArray<ResolvedManagedMcp>, ImportedMcpError>
  readonly watch: () => Stream.Stream<ReadonlyArray<ManagedMcpServerType>>
}

export class ImportedMcpService extends Context.Tag("@jingler/ImportedMcpService")<
  ImportedMcpService,
  ImportedMcpServiceShape
>() {}

interface ImportedMcpServiceOptions {
  readonly metadataFile: string
  readonly secrets: Pick<AgentSecretStore, "readMcp" | "writeMcp" | "deleteMcp">
}

const decodeCatalog = (raw: string): ReadonlyArray<ManagedMcpServerType> =>
  Schema.decodeUnknownSync(Schema.parseJson(McpCatalog))(raw)

const error = (
  operation: ImportedMcpError["operation"],
  message: string
): ImportedMcpError => new ImportedMcpError({ operation, message })

const supportsTarget = (input: ManagedMcpImportInput): boolean =>
  input.scope.kind === "device-local"
    ? input.scope.targetId === input.targetId
    : input.scope.allowedTargets.length === 0 || input.scope.allowedTargets.includes(input.targetId)

const validateInput = (input: ManagedMcpImportInput): void => {
  const normalizedId = input.id.toLowerCase()
  if (RESERVED_IDS.has(normalizedId) || normalizedId.startsWith("jingler-")) {
    throw new Error(`MCP id "${input.id}" is reserved by Jingler`)
  }
  if (!supportsTarget(input)) throw new Error("MCP scope does not include its configured target")
  if (input.transport === "stdio") {
    if (input.command.trim().length === 0 || input.command.includes("\0")) {
      throw new Error("stdio MCP command is invalid")
    }
    if ([...input.args, ...Object.keys(input.env), ...Object.values(input.env)].some((value) => value.includes("\0"))) {
      throw new Error("stdio MCP arguments and environment must not contain NUL bytes")
    }
    return
  }
  const url = new URL(input.url)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Remote MCP URLs must use http or https")
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Remote MCP credentials must be supplied as encrypted headers")
  }
}

const validate = (input: ManagedMcpImportInput): Effect.Effect<void, ImportedMcpError> =>
  Effect.try({
    try: () => validateInput(input),
    catch: (cause) => error("import", cause instanceof Error ? cause.message : "MCP configuration is invalid")
  })

const metadataFor = (input: ManagedMcpImportInput): ManagedMcpServerType => {
  const shared = {
    id: input.id,
    name: input.name,
    kind: "mcp" as const,
    enabled: true,
    trust: "operator-approved" as const,
    scope: input.scope,
    availability: {
      state: "available" as const,
      targetId: input.targetId,
      reason: null
    },
    provenance: {
      ...input.provenance,
      importedAt: new Date().toISOString()
    }
  }
  return input.transport === "stdio"
    ? {
        ...shared,
        transport: "stdio",
        command: input.command,
        args: input.args,
        envKeys: Object.keys(input.env).sort()
      }
    : {
        ...shared,
        transport: input.transport,
        url: input.url,
        headerKeys: Object.keys(input.headers).sort()
      }
}

const secretsFor = (input: ManagedMcpImportInput): ManagedMcpSecretPayload =>
  input.transport === "stdio"
    ? { headers: {}, env: input.env }
    : { headers: input.headers, env: {} }

/** Persists renderer-safe metadata separately from target-local encrypted values. */
export const makeImportedMcpService = (
  options: ImportedMcpServiceOptions
): Effect.Effect<ImportedMcpServiceShape> =>
  Effect.gen(function* () {
    const catalog = new AtomicJsonFile<ReadonlyArray<ManagedMcpServerType>>({
      file: options.metadataFile,
      decode: decodeCatalog,
      fallback: () => []
    })
    const list = Effect.tryPromise({
      try: () => catalog.read(),
      catch: () => error("list", "Could not read imported MCP metadata")
    })
    const mutationLock = yield* Effect.makeSemaphore(1)
    const mutateCatalog = <A>(
      operation: ImportedMcpError["operation"],
      message: string,
      mutation: (
        current: ReadonlyArray<ManagedMcpServerType>,
        persist: (next: ReadonlyArray<ManagedMcpServerType>) => Effect.Effect<void, ImportedMcpError>
      ) => Effect.Effect<A, ImportedMcpError>
    ): Effect.Effect<A, ImportedMcpError> => mutationLock.withPermits(1)(
      Effect.tryPromise({
        try: () => catalog.read(),
        catch: () => error(operation, message)
      }).pipe(
        Effect.flatMap((current) => mutation(
          current,
          (next) => Effect.tryPromise({
            try: () => catalog.write(next),
            catch: () => error(operation, message)
          })
        ))
      )
    )
    const changes = yield* PubSub.unbounded<ReadonlyArray<ManagedMcpServerType>>()
    const publishCatalog = list.pipe(
      Effect.flatMap((servers) => PubSub.publish(changes, servers)),
      Effect.asVoid
    )

    const importServer = (
      input: ManagedMcpImportInput
    ): Effect.Effect<ManagedMcpServerType, ImportedMcpError> => {
      const metadata = metadataFor(input)
      return validate(input).pipe(
        Effect.zipRight(
          mutateCatalog(
            "import",
            "Could not persist MCP metadata",
            (current, persist) => {
              if (current.some((server) => server.id === input.id)) {
                return Effect.fail(error("import", `MCP id "${input.id}" already exists`))
              }
              return Effect.acquireUseRelease(
                options.secrets.writeMcp(input.id, input.targetId, secretsFor(input)).pipe(
                  Effect.mapError(() => error("import", "Could not persist encrypted MCP values"))
                ),
                () => persist([...current, metadata]),
                (_, exit) => Exit.isSuccess(exit)
                  ? Effect.void
                  : persist(current).pipe(
                      Effect.ignore,
                      Effect.zipRight(options.secrets.deleteMcp(input.id, input.targetId).pipe(Effect.ignore))
                    )
              ).pipe(Effect.as(metadata))
            }
          )
        ),
        Effect.tap(() => publishCatalog),
        Effect.as(metadata)
      )
    }

    const remove = (id: ManagedResourceId): Effect.Effect<void, ImportedMcpError> =>
      mutateCatalog(
        "remove",
        `Could not remove MCP server "${id}"`,
        (current, persist) => {
          const server = current.find((item) => item.id === id)
          if (server === undefined) return Effect.fail(error("remove", `MCP server "${id}" does not exist`))
          const targetId = server.availability.targetId
          return Effect.acquireUseRelease(
            options.secrets.readMcp(id, targetId).pipe(
              Effect.mapError(() => error("remove", `Could not read encrypted values for "${id}"`)),
              Effect.tap(() => persist(current.filter((item) => item.id !== id)))
            ),
            () => options.secrets.deleteMcp(id, targetId).pipe(
              Effect.mapError(() => error("remove", `Could not remove encrypted values for "${id}"`))
            ),
            (secret, exit) => Exit.isSuccess(exit)
              ? Effect.void
              : (secret === null
                  ? Effect.void
                  : options.secrets.writeMcp(id, targetId, secret).pipe(Effect.ignore)
                ).pipe(Effect.zipRight(persist(current).pipe(Effect.ignore)))
          )
        }
      ).pipe(Effect.zipRight(publishCatalog))

    const setEnabled = (
      id: ManagedResourceId,
      enabled: boolean
    ): Effect.Effect<void, ImportedMcpError> =>
      mutateCatalog(
        "enable",
        `Could not update MCP server "${id}"`,
        (current, persist) => current.some((server) => server.id === id)
          ? persist(current.map((server) => server.id === id ? { ...server, enabled } : server))
          : Effect.fail(error("enable", `MCP server "${id}" does not exist`))
      ).pipe(Effect.zipRight(publishCatalog))

    const resolveForTarget = (
      targetId: string
    ): Effect.Effect<ReadonlyArray<ResolvedManagedMcp>, ImportedMcpError> =>
      list.pipe(
        Effect.flatMap((servers) => Effect.forEach(
          servers.filter((server) =>
            server.enabled && server.availability.state === "available" &&
            server.availability.targetId === targetId
          ),
          (server) => options.secrets.readMcp(server.id, targetId).pipe(
            Effect.mapError(() => error("resolve", `Could not read encrypted values for "${server.id}"`)),
            Effect.flatMap((secret) => {
              if (secret === null) return Effect.fail(error("resolve", `MCP server "${server.id}" is unavailable on this target`))
              return Effect.succeed<ResolvedManagedMcp>(server.transport === "stdio"
                ? {
                    id: server.id,
                    name: server.name,
                    transport: "stdio",
                    command: server.command,
                    args: server.args,
                    env: secret.env
                  }
                : {
                    id: server.id,
                    name: server.name,
                    transport: server.transport,
                    url: server.url,
                    headers: secret.headers
                  })
            })
          ),
          { concurrency: 4 }
        ))
      )

    return {
      list,
      importServer,
      remove,
      setEnabled,
      resolveForTarget,
      watch: () => Stream.concat(
        Stream.fromEffect(list.pipe(Effect.orElseSucceed(() => []))),
        Stream.fromPubSub(changes)
      )
    }
  })
