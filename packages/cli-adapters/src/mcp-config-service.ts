import { createHash } from "node:crypto"
import { FileSystem } from "@effect/platform"
import type { McpConfigEntry, McpRemoteAuth, McpServer } from "@jingler/core"
import {
  interpolateEnvRecord,
  McpConfigEntry as McpConfigEntrySchema,
  McpConfigFile,
  mcpNameError
} from "@jingler/core"
import { Data, Effect, Option, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { McpAuthStore, type StoredMcpCredential } from "./mcp-auth-store.js"
import { isMcpOAuthAuthorizationActive } from "./mcp-oauth-flow.js"
import { makeMcpOAuthProvider } from "./mcp-oauth.js"
import type { SecretStoreShape } from "./secret-store.js"
import type { ParsedMcpServer, RuntimeMcpServer } from "./runtime/mcp/attachment.js"

/**
 * `~/jingler/mcp.json` — the single source of truth for operator-configured
 * MCP servers, opencode-compatible (see `McpConfigFile` in `@jingler/core`).
 *
 * Hand-edits and UI-edits go through the same file, so they can never diverge.
 * The file may hold literal secrets; only the redacted `McpServer` shape
 * (`list`) may cross to the renderer. `resolve` (secret-bearing) is for the
 * main-process runtime only.
 */

export class McpConfigError extends Data.TaggedError("McpConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

type Env = FileSystem.FileSystem | AppPaths

const decodeFile = Schema.decodeUnknown(Schema.parseJson(McpConfigFile))

const RawMcpDocument = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const RawMcpEntries = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const RawMcpEntry = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const decodeRawDocument = Schema.decodeUnknown(Schema.parseJson(RawMcpDocument))
const decodeRawEntries = Schema.decodeUnknownOption(RawMcpEntries)
const decodeRawEntry = Schema.decodeUnknownOption(RawMcpEntry)

const credentialIdentity = (entry: McpConfigEntry): string | undefined =>
  entry.type === "remote" && entry.auth !== undefined
    ? createHash("sha256").update(JSON.stringify({
        url: entry.url,
        transport: entry.transport ?? "http",
        auth: entry.auth
      })).digest("hex")
    : undefined

/** Redact one entry into the renderer-safe shape. */
const redact = (name: string, entry: McpConfigEntry): McpServer =>
  entry.type === "remote"
    ? {
        name,
        displayName: entry.displayName ?? name,
        iconUrl: entry.iconUrl ?? null,
        authKind: entry.auth?.type ?? "none",
        authState: entry.auth === undefined ? "not-required" : "needs-auth",
        transport: entry.transport ?? "http",
        scope: "user",
        target: entry.url,
        envKeys: [],
        headerKeys: Object.keys(entry.headers).sort(),
        enabled: entry.enabled
      }
    : {
        name,
        displayName: entry.displayName ?? name,
        iconUrl: entry.iconUrl ?? null,
        authKind: "none",
        authState: "not-required",
        transport: "stdio",
        scope: "user",
        target: entry.command.join(" "),
        envKeys: Object.keys(entry.environment).sort(),
        headerKeys: [],
        enabled: entry.enabled
      }

/** Interpolate `{env:VAR}` and produce the secret-bearing runtime attachment. */
const toRuntime = (
  name: string,
  entry: McpConfigEntry,
  env: Readonly<Record<string, string | undefined>>
): RuntimeMcpServer =>
  entry.type === "remote"
    ? {
        name,
        ...(entry.transport === "sse" ? { transport: "sse" as const } : {}),
        url: entry.url,
        headers: interpolateEnvRecord(entry.headers, env)
      }
    : {
        name,
        transport: "stdio",
        command: entry.command[0] ?? "",
        args: entry.command.slice(1),
        env: interpolateEnvRecord(entry.environment, env),
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd })
      }

const authState = (
  server: McpServer,
  credential: StoredMcpCredential | null,
  authorizing: boolean
): McpServer["authState"] => {
  if (authorizing) return "authorizing"
  if (server.authKind === "none") return "not-required"
  if (credential?.type !== server.authKind) return "needs-auth"
  return credential.type !== "oauth" || credential.tokens !== undefined ? "ready" : "needs-auth"
}

const resolvedOAuthConfig = (
  entry: McpConfigEntry,
  env: Readonly<Record<string, string | undefined>>
) => {
  if (entry.type !== "remote" || entry.auth?.type !== "oauth") return undefined
  const interpolate = (value: string) => interpolateEnvRecord({ value }, env).value
  return {
    ...(entry.auth.clientId === undefined ? {} : { clientId: interpolate(entry.auth.clientId) }),
    ...(entry.auth.clientSecret === undefined ? {} : { clientSecret: interpolate(entry.auth.clientSecret) }),
    ...(entry.auth.scope === undefined ? {} : { scope: entry.auth.scope })
  }
}

const withCredential = async (
  name: string,
  entry: McpConfigEntry,
  runtime: RuntimeMcpServer,
  store: McpAuthStore,
  env: Readonly<Record<string, string | undefined>>
): Promise<RuntimeMcpServer> => {
  if (entry.type !== "remote" || entry.auth === undefined || runtime.transport === "stdio") {
    return runtime
  }
  const identity = credentialIdentity(entry)
  if (identity === undefined) return runtime
  const credential = await Effect.runPromise(store.read(name, identity))
  if (entry.auth.type === "api-key") {
    if (credential?.type !== "api-key") return runtime
    const apiKey = credential.apiKey
    return {
      ...runtime,
      headers: {
        ...runtime.headers,
        [entry.auth.header]: `${entry.auth.prefix}${apiKey}`
      },
      onUnauthorized: () => {
        void Effect.runPromise(store.deleteIf(name, (current) =>
          current.identity === identity && current.type === "api-key" && current.apiKey === apiKey
        ))
      }
    }
  }
  if (credential?.type !== "oauth") return runtime
  return {
    ...runtime,
    authProvider: makeMcpOAuthProvider(
      name,
      identity,
      resolvedOAuthConfig(entry, env) ?? {},
      store,
      async () => {
        if (isMcpOAuthAuthorizationActive(name, identity)) return
        await Effect.runPromise(store.update(name, identity, (current) =>
          current?.type === "oauth" && current.clientInformation !== undefined
            ? { type: "oauth", identity, clientInformation: current.clientInformation }
            : { type: "oauth", identity }
        ))
      },
      () => !isMcpOAuthAuthorizationActive(name, identity)
    )
  }
}

/** Pair redacted metadata with launch details, for the shared probe. */
const toParsed = (
  name: string,
  entry: McpConfigEntry,
  env: Readonly<Record<string, string | undefined>>
): ParsedMcpServer => {
  if (entry.type === "local") {
    return {
      server: redact(name, entry),
      launch: {
        transport: "stdio",
        command: entry.command[0] ?? "",
        args: entry.command.slice(1),
        env: interpolateEnvRecord(entry.environment, env),
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        headers: {}
      }
    }
  }
  const identity = credentialIdentity(entry)
  const oauth = resolvedOAuthConfig(entry, env)
  return {
    server: redact(name, entry),
    ...(identity === undefined ? {} : { credentialIdentity: identity }),
    launch: {
      transport: entry.transport ?? "http",
      args: [],
      env: {},
      url: entry.url,
      headers: interpolateEnvRecord(entry.headers, env),
      ...(oauth === undefined ? {} : { oauth })
    }
  }
}

// ponytail: mutations serialize on one process-wide semaphore; per-file locks
// if a second mcp.json path ever exists.
const mutationLock = Effect.unsafeMakeSemaphore(1)
let writeSequence = 0

export class McpConfigService extends Effect.Service<McpConfigService>()(
  "@jingler/McpConfigService",
  {
    accessors: true,
    sync: () => {
      /** Raw top-level JSON, preserved so unknown keys survive a rewrite. */
      const readRaw = (): Effect.Effect<Record<string, unknown>, McpConfigError, Env> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const exists = yield* fs
            .exists(paths.mcpConfigFile)
            .pipe(Effect.orElseSucceed(() => false))
          if (!exists) return {}
          const raw = yield* fs
            .readFileString(paths.mcpConfigFile)
            .pipe(
              Effect.mapError((cause) =>
                new McpConfigError({ message: "Failed to read mcp.json", cause })
              )
            )
          return yield* decodeRawDocument(raw).pipe(
            Effect.mapError((cause) =>
              new McpConfigError({ message: "mcp.json must be a valid JSON object", cause })
            )
          )
        })

      const decodeEntries = (
        raw: Record<string, unknown>
      ): Effect.Effect<Readonly<Record<string, McpConfigEntry>>, McpConfigError> =>
        decodeFile(JSON.stringify(raw)).pipe(
          Effect.mapError(
            (cause) => new McpConfigError({ message: "mcp.json is malformed", cause })
          ),
          Effect.map((file) => file.mcp)
        )

      const entries = (): Effect.Effect<
        Readonly<Record<string, McpConfigEntry>>,
        McpConfigError,
        Env
      > => readRaw().pipe(Effect.flatMap(decodeEntries))

      const persist = (
        raw: Record<string, unknown>,
        mcp: Readonly<Record<string, unknown>>
      ): Effect.Effect<void, McpConfigError, Env> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
            Effect.mapError((cause) =>
              new McpConfigError({ message: "Failed to write mcp.json", cause })
            )
          )
          const temporary = `${paths.mcpConfigFile}.${process.pid}.${++writeSequence}.tmp`
          yield* fs
            .writeFileString(
              temporary,
              `${JSON.stringify({ ...raw, mcp }, null, 2)}\n`,
              { flag: "wx", mode: 0o600 }
            )
            .pipe(
              Effect.andThen(fs.rename(temporary, paths.mcpConfigFile)),
              Effect.mapError((cause) =>
                new McpConfigError({ message: "Failed to write mcp.json", cause })
              ),
              Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore))
            )
        })

      /**
       * Read-validate-mutate-write under the lock. Mutating a malformed file
       * fails (rather than clobbering whatever the operator was editing).
       */
      const mutate = (
        mutation: (
          current: Readonly<Record<string, McpConfigEntry>>,
          rawMcp: Readonly<Record<string, unknown>>
        ) => Effect.Effect<Readonly<Record<string, unknown>>, McpConfigError>
      ): Effect.Effect<void, McpConfigError, Env> =>
        mutationLock.withPermits(1)(
          Effect.gen(function* () {
            const raw = yield* readRaw()
            const current = yield* decodeEntries(raw)
            const rawMcp = Option.getOrElse(decodeRawEntries(raw.mcp), () => ({}))
            const next = yield* mutation(current, rawMcp)
            yield* persist(raw, next)
          })
        )

      /** Renderer-safe list. Redaction happens here, before any RPC boundary. */
      const list = (): Effect.Effect<ReadonlyArray<McpServer>, McpConfigError, Env> =>
        entries().pipe(
          Effect.map((mcp) =>
            Object.entries(mcp).map(([name, entry]) => redact(name, entry))
          )
        )

      const listAuthenticated = (
        secretStore: SecretStoreShape
      ): Effect.Effect<ReadonlyArray<McpServer>, McpConfigError, Env> =>
        entries().pipe(Effect.flatMap((configured) => {
          const auth = new McpAuthStore(secretStore)
          return Effect.forEach(Object.entries(configured), ([name, entry]) => {
            const server = redact(name, entry)
            const identity = credentialIdentity(entry)
            if (identity === undefined) return Effect.succeed(server)
            return auth.read(name, identity).pipe(Effect.map((credential) => ({
              ...server,
              authState: authState(
                server,
                credential,
                isMcpOAuthAuthorizationActive(name, identity)
              )
            })))
          })
        }))

      /**
       * Enabled entries as secret-bearing runtime attachments. Best-effort: a
       * malformed file yields an empty list so a broken mcp.json never blocks
       * a session — Settings surfaces the parse error via `list` instead.
       */
      const resolve = (
        env: Readonly<Record<string, string | undefined>> = process.env
      ): Effect.Effect<ReadonlyArray<RuntimeMcpServer>, never, Env> =>
        entries().pipe(
          Effect.map((mcp) =>
            Object.entries(mcp)
              .filter(([name, entry]) => entry.enabled && mcpNameError(name) === null)
              .map(([name, entry]) => toRuntime(name, entry, env))
          ),
          Effect.orElseSucceed(() => [])
        )

      const resolveAuthenticated = (
        secretStore: SecretStoreShape,
        env: Readonly<Record<string, string | undefined>> = process.env
      ): Effect.Effect<ReadonlyArray<RuntimeMcpServer>, never, Env> =>
        entries().pipe(
          Effect.flatMap((mcp) => {
            const auth = new McpAuthStore(secretStore)
            return Effect.forEach(
              Object.entries(mcp).filter(([name, entry]) => entry.enabled && mcpNameError(name) === null),
              ([name, entry]) => Effect.promise(() => withCredential(name, entry, toRuntime(name, entry, env), auth, env))
            )
          }),
          Effect.orElseSucceed(() => [])
        )

      /** Every entry (enabled or not) paired with launch details, for probing. */
      const parsed = (
        env: Readonly<Record<string, string | undefined>> = process.env
      ): Effect.Effect<ReadonlyArray<ParsedMcpServer>, McpConfigError, Env> =>
        entries().pipe(
          Effect.map((mcp) =>
            Object.entries(mcp).map(([name, entry]) => toParsed(name, entry, env))
          )
        )

      const parsedAuthenticated = (
        secretStore: SecretStoreShape,
        env: Readonly<Record<string, string | undefined>> = process.env
      ): Effect.Effect<ReadonlyArray<ParsedMcpServer>, McpConfigError, Env> =>
        entries().pipe(Effect.flatMap((mcp) => {
          const auth = new McpAuthStore(secretStore)
          return Effect.forEach(Object.entries(mcp), ([name, entry]) => {
            const parsed = toParsed(name, entry, env)
            return Effect.promise(async () => {
              const runtime = await withCredential(name, entry, toRuntime(name, entry, env), auth, env)
              return runtime.transport === "stdio"
                ? parsed
                : { ...parsed, launch: { ...parsed.launch, headers: runtime.headers, authProvider: runtime.authProvider, onUnauthorized: runtime.onUnauthorized } }
            })
          })
        }))

      const writeAll = (
        additions: Readonly<Record<string, McpConfigEntry>>
      ): Effect.Effect<void, McpConfigError, Env> => {
        const names = Object.keys(additions)
        if (names.length === 0) return Effect.void
        const nameProblem = names.map(mcpNameError).find((problem) => problem !== null)
        if (nameProblem !== undefined && nameProblem !== null) {
          return Effect.fail(new McpConfigError({ message: nameProblem }))
        }
        return Effect.forEach(Object.entries(additions), ([name, entry]) =>
          Schema.decodeUnknown(McpConfigEntrySchema)(entry).pipe(
            Effect.map((decoded) => [name, decoded] as const),
            Effect.mapError((cause) =>
              new McpConfigError({ message: `MCP server "${name}" is malformed`, cause })
            )
          )
        ).pipe(
          Effect.flatMap((decoded) =>
            mutate((_current, rawMcp) =>
              Effect.succeed({ ...rawMcp, ...Object.fromEntries(decoded) })
            )
          )
        )
      }

      const write = (
        name: string,
        entry: McpConfigEntry
      ): Effect.Effect<void, McpConfigError, Env> => writeAll({ [name]: entry })

      const remove = (name: string): Effect.Effect<void, McpConfigError, Env> =>
        mutate((current, rawMcp) => {
          if (!(name in current)) {
            return Effect.fail(new McpConfigError({ message: `MCP server "${name}" does not exist` }))
          }
          const { [name]: _removed, ...rest } = rawMcp
          return Effect.succeed(rest)
        })

      const setEnabled = (
        name: string,
        enabled: boolean
      ): Effect.Effect<void, McpConfigError, Env> =>
        mutate((current, rawMcp) => {
          const entry = current[name]
          if (entry === undefined) {
            return Effect.fail(new McpConfigError({ message: `MCP server "${name}" does not exist` }))
          }
          const rawEntry = rawMcp[name]
          return Effect.succeed({
            ...rawMcp,
            [name]: {
              ...Option.getOrElse(decodeRawEntry(rawEntry), () => entry),
              enabled
            }
          })
        })

      const setAuth = (
        name: string,
        auth: McpRemoteAuth
      ): Effect.Effect<void, McpConfigError, Env> =>
        mutate((current, rawMcp) => {
          const entry = current[name]
          if (entry?.type !== "remote") {
            return Effect.fail(new McpConfigError({ message: `Remote MCP server "${name}" does not exist` }))
          }
          const next = {
            ...rawMcp,
            [name]: {
              ...Option.getOrElse(decodeRawEntry(rawMcp[name]), () => entry),
              auth
            }
          }
          return decodeFile(JSON.stringify({ mcp: next })).pipe(
            Effect.as(next),
            Effect.mapError((cause) => new McpConfigError({ message: "MCP authentication is not valid for this server", cause }))
          )
        })

      return {
        list,
        listAuthenticated,
        resolve,
        resolveAuthenticated,
        parsed,
        parsedAuthenticated,
        write,
        writeAll,
        remove,
        setEnabled,
        setAuth
      }
    }
  }
) {}
