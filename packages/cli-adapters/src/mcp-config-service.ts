import { FileSystem } from "@effect/platform"
import type { McpConfigEntry, McpServer } from "@jingler/core"
import { interpolateEnvRecord, McpConfigFile, mcpNameError } from "@jingler/core"
import { Data, Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Redact one entry into the renderer-safe shape. */
const redact = (name: string, entry: McpConfigEntry): McpServer =>
  entry.type === "remote"
    ? {
        name,
        transport: entry.transport ?? "http",
        scope: "user",
        target: entry.url,
        envKeys: [],
        headerKeys: Object.keys(entry.headers).sort(),
        enabled: entry.enabled
      }
    : {
        name,
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
        headers: interpolateEnvRecord(entry.headers, env).values
      }
    : {
        name,
        transport: "stdio",
        command: entry.command[0] ?? "",
        args: entry.command.slice(1),
        env: interpolateEnvRecord(entry.environment, env).values,
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd })
      }

/** Pair redacted metadata with launch details, for the shared probe. */
const toParsed = (
  name: string,
  entry: McpConfigEntry,
  env: Readonly<Record<string, string | undefined>>
): ParsedMcpServer =>
  entry.type === "remote"
    ? {
        server: redact(name, entry),
        launch: {
          transport: entry.transport ?? "http",
          args: [],
          env: {},
          url: entry.url,
          headers: interpolateEnvRecord(entry.headers, env).values
        }
      }
    : {
        server: redact(name, entry),
        launch: {
          transport: "stdio",
          command: entry.command[0] ?? "",
          args: entry.command.slice(1),
          env: interpolateEnvRecord(entry.environment, env).values,
          headers: {}
        }
      }

// ponytail: mutations serialize on one process-wide semaphore; per-file locks
// if a second mcp.json path ever exists.
const mutationLock = Effect.unsafeMakeSemaphore(1)

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
          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) => new McpConfigError({ message: "mcp.json is not valid JSON", cause })
          })
          if (!isRecord(parsed)) {
            return yield* Effect.fail(new McpConfigError({ message: "mcp.json must be a JSON object" }))
          }
          return parsed
        })

      const entries = (): Effect.Effect<
        Readonly<Record<string, McpConfigEntry>>,
        McpConfigError,
        Env
      > =>
        readRaw().pipe(
          Effect.flatMap((raw) =>
            decodeFile(JSON.stringify(raw)).pipe(
              Effect.mapError(
                (cause) => new McpConfigError({ message: "mcp.json is malformed", cause })
              )
            )
          ),
          Effect.map((file) => file.mcp)
        )

      const persist = (
        raw: Record<string, unknown>,
        mcp: Readonly<Record<string, unknown>>
      ): Effect.Effect<void, McpConfigError, Env> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(Effect.ignore)
          yield* fs
            .writeFileString(paths.mcpConfigFile, `${JSON.stringify({ ...raw, mcp }, null, 2)}\n`)
            .pipe(
              Effect.mapError((cause) =>
                new McpConfigError({ message: "Failed to write mcp.json", cause })
              )
            )
        })

      /**
       * Read-validate-mutate-write under the lock. Mutating a malformed file
       * fails (rather than clobbering whatever the operator was editing).
       */
      const mutate = (
        mutation: (
          current: Readonly<Record<string, McpConfigEntry>>
        ) => Effect.Effect<Readonly<Record<string, unknown>>, McpConfigError>
      ): Effect.Effect<void, McpConfigError, Env> =>
        mutationLock.withPermits(1)(
          Effect.gen(function* () {
            const raw = yield* readRaw()
            const current = yield* entries()
            const next = yield* mutation(current)
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

      /** Every entry (enabled or not) paired with launch details, for probing. */
      const parsed = (
        env: Readonly<Record<string, string | undefined>> = process.env
      ): Effect.Effect<ReadonlyArray<ParsedMcpServer>, McpConfigError, Env> =>
        entries().pipe(
          Effect.map((mcp) =>
            Object.entries(mcp).map(([name, entry]) => toParsed(name, entry, env))
          )
        )

      const write = (
        name: string,
        entry: McpConfigEntry
      ): Effect.Effect<void, McpConfigError, Env> => {
        const nameProblem = mcpNameError(name)
        if (nameProblem !== null) {
          return Effect.fail(new McpConfigError({ message: nameProblem }))
        }
        return mutate((current) => Effect.succeed({ ...current, [name]: entry }))
      }

      const remove = (name: string): Effect.Effect<void, McpConfigError, Env> =>
        mutate((current) => {
          if (!(name in current)) {
            return Effect.fail(new McpConfigError({ message: `MCP server "${name}" does not exist` }))
          }
          const { [name]: _removed, ...rest } = current
          return Effect.succeed(rest)
        })

      const setEnabled = (
        name: string,
        enabled: boolean
      ): Effect.Effect<void, McpConfigError, Env> =>
        mutate((current) => {
          const entry = current[name]
          if (entry === undefined) {
            return Effect.fail(new McpConfigError({ message: `MCP server "${name}" does not exist` }))
          }
          return Effect.succeed({ ...current, [name]: { ...entry, enabled } })
        })

      return { entries, list, resolve, parsed, write, remove, setEnabled }
    }
  }
) {}
