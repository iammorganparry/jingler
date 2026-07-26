/**
 * The wire between Starbase's main process and the plugin extension host.
 *
 * ## Why plugin backends run in a separate process at all
 *
 * A plugin's host half is Node with full access — it shells out, it reaches the
 * network, it reads files. Running that inside main would mean a plugin's
 * infinite loop freezes the RPC server that every session depends on, and a
 * plugin's uncaught exception takes the app down with it. In its own
 * `utilityProcess` a plugin can hang or crash and cost only itself: main notices
 * the exit, marks it errored, and the window carries on.
 *
 * ## Why messages are plain JSON with explicit tags
 *
 * Electron's `utilityProcess` channel is structured-clone, which drops functions,
 * class instances and `Error` prototypes. Rather than discover that per field,
 * everything here is a flat tagged object of JSON-safe values, and errors cross
 * as `{ message }` rather than as an `Error`.
 *
 * ## Why NOT `@effect/rpc`, given main↔renderer uses it
 *
 * Asked in review, and measured rather than argued: importing `effect` plus
 * `@effect/rpc` costs **~190ms**, against ~1ms for the entry as it stands
 * (`node:url` and types). That lands once per session on the first plugin
 * activation — which is precisely the interaction lazy activation exists to keep
 * quick, and the extension host is the one process in the app where staying
 * dependency-light is a feature rather than an economy.
 *
 * Two other things make the trade worse here than at the renderer boundary.
 * This channel is bidirectional — main asks the host to activate and invoke,
 * the host asks main for storage, `exec` and credentials — so it would need two
 * `RpcGroup`s multiplexed over one channel rather than the server/client pair
 * `main/rpc.ts` gets away with. And the payloads are genuinely `unknown`: a
 * plugin command's argument and return value are arbitrary JSON by definition,
 * so schema validation buys far less than it does for `StarbaseRpcs`, where
 * every field has a known shape.
 *
 * What the hand-rolled version costs is correlation code, which is exactly the
 * kind of thing that harbours subtle bugs — so it is tested directly, over a
 * fake `HostProcess`, including the crash and double-crash paths that a real
 * spawn could not reach. Two bugs were found that way and fixed: a leaked
 * activation timer, and an unhandled rejection on restart.
 *
 * ## Correlation
 *
 * Both directions can initiate: main asks the host to run a command, and the
 * host asks main for storage, `exec` or credentials. Each request carries a
 * `requestId` the reply echoes, so the two flows never have to be interleaved
 * carefully — they are simply independent.
 */

/** Everything main sends to the extension host. */
export type ToHostMessage =
  | {
      readonly kind: "activate"
      /** Correlates with `activated` / `activation-failed`. */
      readonly requestId: string
      readonly pluginId: string
      /** Absolute path to the plugin's `main` entry. */
      readonly entry: string
      /** Command ids the manifest declares, so the host can reject undeclared ones. */
      readonly declaredCommands: ReadonlyArray<string>
    }
  | { readonly kind: "deactivate"; readonly requestId: string; readonly pluginId: string }
  | {
      readonly kind: "invoke"
      readonly requestId: string
      readonly pluginId: string
      readonly commandId: string
      readonly arg?: unknown
    }
  /** A reply to something the HOST asked main for. */
  | {
      readonly kind: "host-reply"
      readonly requestId: string
      readonly ok: boolean
      readonly value?: unknown
      readonly message?: string
    }

/** Everything the extension host sends back to main. */
export type FromHostMessage =
  | { readonly kind: "activated"; readonly requestId: string; readonly pluginId: string }
  | {
      readonly kind: "activation-failed"
      readonly requestId: string
      readonly pluginId: string
      readonly message: string
    }
  | { readonly kind: "deactivated"; readonly requestId: string; readonly pluginId: string }
  | {
      readonly kind: "invoke-result"
      readonly requestId: string
      readonly ok: boolean
      readonly value?: unknown
      readonly message?: string
    }
  /** The host asking main to do something on a plugin's behalf. */
  | {
      readonly kind: "host-request"
      readonly requestId: string
      readonly pluginId: string
      readonly op: HostOp
      readonly payload: unknown
    }
  /** A plugin emitted an event for the renderer. */
  | {
      readonly kind: "event"
      readonly pluginId: string
      readonly topic: string
      readonly payload: unknown
    }
  | {
      readonly kind: "log"
      readonly pluginId: string
      readonly level: "debug" | "info" | "warn" | "error"
      readonly message: string
    }
  /** The host finished booting and is ready for `activate`. */
  | { readonly kind: "ready" }

/**
 * What a plugin can ask main to do.
 *
 * A closed union rather than a free-form string: main dispatches on it, and an
 * unrecognised op has to be a compile error somewhere rather than a silent
 * no-op that leaves a plugin waiting on a promise that never settles.
 */
export type HostOp =
  | "storage.get"
  | "storage.set"
  | "storage.delete"
  | "storage.keys"
  | "exec"
  | "auth.getSession"

/** `exec` payload — mirrors `ExecOptions` in the SDK. */
export interface ExecRequest {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly input?: string
  readonly timeoutMs?: number
}

export interface ExecReply {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export interface AuthSessionRequestPayload {
  readonly providerId: string
  readonly scopes: ReadonlyArray<string>
  readonly createIfNone?: boolean
}

/** The channel name the utilityProcess uses. One channel, tagged messages. */
export const PLUGIN_HOST_CHANNEL = "starbase/plugin-host"

/**
 * How long main waits for the host to report `ready` before giving up.
 *
 * Generous, because a cold Node start on a loaded machine is not fast, and the
 * cost of being wrong is an app that reports every plugin as broken on a slow
 * boot.
 */
export const HOST_READY_TIMEOUT_MS = 10_000

/**
 * How long a plugin's `activate` may take before it is treated as hung.
 *
 * A plugin awaiting a network call it will never get must not hold the
 * activation queue open forever — the tab that triggered it is on screen,
 * waiting.
 */
export const ACTIVATE_TIMEOUT_MS = 15_000
