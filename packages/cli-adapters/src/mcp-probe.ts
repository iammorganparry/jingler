import type { McpServerStatus } from "@jingler/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { isAbsolute, resolve } from "node:path"
import { Duration, Effect } from "effect"
import type { McpLaunch, ParsedMcpServer } from "./runtime/mcp/attachment.js"
import { neutralCwd } from "./cwd.js"

/**
 * Live probing: does a configured MCP server actually answer?
 *
 * Reading config only tells us a server is *configured*. This runs the real MCP
 * handshake (`initialize`, then `tools/list`) via the official SDK client, so the
 * UI can say "connected, 6 tools" rather than merely "present in a file".
 *
 * TRUST: this spawns the server command, so probing is user-initiated only. Only
 * operator-approved managed entries reach this service.
 */

/**
 * A cold `npx -y <pkg>` has to hit the registry and install before it says anything,
 * which routinely runs past 10s — and most real configs are exactly that shape. Too
 * short a timeout reports "failed" for a healthy server and then CACHES that answer,
 * so the bias is deliberately towards waiting. Still bounded, so one hung server
 * can't wedge the dialog.
 */
export const PROBE_TIMEOUT = Duration.seconds(15)

/** Bounded so a config with twenty servers doesn't fork twenty processes at once. */
export const PROBE_CONCURRENCY = 4

/** Error text is shown in the UI; cap it so a server dumping a stack can't flood the dialog. */
const MAX_ERROR = 200
const UNAUTHORIZED = /\b(401|unauthori[sz]ed|invalid[_ -]token)\b/iu

const clientInfo = { name: "jingler", version: "0.0.0" } as const

const makeTransport = (launch: McpLaunch, cwd: string | null) => {
  if (launch.transport === "stdio") {
    if (launch.command === undefined) throw new Error("stdio server has no command")
    return new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      /**
       * Merge over the SDK's default environment rather than replacing it: passing
       * `env` alone would drop PATH/HOME and make almost every server fail to spawn,
       * which would look like a broken server rather than a broken probe.
       */
      env: { ...getDefaultEnvironment(), ...launch.env },
      /**
       * Project servers may use relative paths, so probe from the session's
       * worktree — and when there ISN'T one (a user-scope server probed from
       * Settings), from an explicitly neutral directory.
       *
       * Never omit `cwd`. Omitting it makes the server inherit the Electron main
       * process's cwd, which in development is whichever worktree `pnpm dev` was
       * launched from. A server that writes a relative path then creates files
       * inside an unrelated repo's checkout — which is exactly how a wowlogs-mcp
       * SQLite database ended up as an untracked file in the jingler repo.
       */
      cwd: launch.cwd === undefined
        ? cwd ?? neutralCwd()
        : isAbsolute(launch.cwd) ? launch.cwd : resolve(cwd ?? neutralCwd(), launch.cwd),
      // The server's stderr is noise here; we report the handshake result, not its logs.
      stderr: "ignore"
    })
  }
  if (launch.url === undefined) throw new Error("remote server has no url")
  const url = new URL(launch.url)
  const requestInit = Object.keys(launch.headers).length > 0 ? { headers: { ...launch.headers } } : undefined
  const observedFetch = launch.onUnauthorized === undefined
    ? undefined
    : async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init)
        if (response.status === 401) launch.onUnauthorized?.()
        return response
      }
  return launch.transport === "sse"
    ? new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: observedFetch } })
    : new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider: launch.authProvider,
        fetch: observedFetch
      })
}

/**
 * Connect, count tools, and always close.
 *
 * The `signal` is wired to Effect's interruption, so a timeout tears the transport
 * down instead of leaving an orphaned child process behind.
 */
const connectAndCount = async (launch: McpLaunch, cwd: string | null, signal: AbortSignal): Promise<number> => {
  const client = new Client(clientInfo, { capabilities: {} })
  const transport = makeTransport(launch, cwd)
  const abort = () => void client.close().catch(() => {})
  signal.addEventListener("abort", abort, { once: true })
  try {
    // `connect` performs the MCP `initialize` handshake.
    await client.connect(transport)
    const { tools } = await client.listTools()
    return tools.length
  } finally {
    signal.removeEventListener("abort", abort)
    await client.close().catch(() => {})
  }
}

const message = (cause: unknown): string => {
  const raw = cause instanceof Error ? cause.message : String(cause)
  return raw.length > MAX_ERROR ? `${raw.slice(0, MAX_ERROR)}…` : raw
}

const isUnauthorized = (cause: unknown): boolean =>
  cause instanceof UnauthorizedError || UNAUTHORIZED.test(message(cause))

/**
 * Probe one server. Never fails — a probe that cannot connect is a `failed` status,
 * not an error, because "this server is broken" is exactly what we want to display.
 */
export const probeServer = (
  entry: ParsedMcpServer,
  cwd: string | null,
  now: () => string,
  /** Overridable so tests can exercise the timeout without a 15s wall-clock wait. */
  timeout: Duration.Duration = PROBE_TIMEOUT
): Effect.Effect<McpServerStatus> => {
  const base = { name: entry.server.name, scope: entry.server.scope }

  // A disabled managed server is reported as such rather than probed.
  if (!entry.server.enabled) {
    return Effect.succeed({ ...base, state: "disabled" as const, toolCount: null, error: null, checkedAt: now() })
  }

  return Effect.tryPromise({
    try: (signal) => connectAndCount(entry.launch, cwd, signal),
    catch: (cause) => ({ message: message(cause), unauthorized: isUnauthorized(cause) })
  }).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () => ({
        message: `timed out after ${Duration.toMillis(timeout)}ms`,
        unauthorized: false
      })
    }),
    Effect.map((toolCount) => ({
      ...base,
      state: "connected" as const,
      toolCount,
      error: null,
      checkedAt: now()
    })),
    Effect.catchAll((error) =>
      Effect.succeed({
        ...base,
        state: error.unauthorized && entry.server.authKind !== "none"
          ? "needs-auth" as const
          : "failed" as const,
        toolCount: null,
        error: error.message,
        checkedAt: now()
      })
    )
  )
}

/** Probe many servers concurrently, bounded. Order matches the input. */
export const probeAll = (
  entries: ReadonlyArray<ParsedMcpServer>,
  cwd: string | null,
  now: () => string,
  timeout: Duration.Duration = PROBE_TIMEOUT
): Effect.Effect<ReadonlyArray<McpServerStatus>> =>
  Effect.forEach(entries, (entry) => probeServer(entry, cwd, now, timeout), {
    concurrency: PROBE_CONCURRENCY
  })
