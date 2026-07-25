/**
 * The extension host: the Node process a plugin's `main` half runs inside.
 *
 * ## What this file is
 *
 * It is the other end of `plugin-host-protocol.ts`. It receives `activate`,
 * imports the plugin's entry, builds the {@link HostContext} the SDK documents,
 * and calls the plugin's exported `activate`. Everything the context can do that
 * this process cannot do alone — storage, `exec`, credentials — is forwarded to
 * main as a `host-request` and awaited.
 *
 * ## Why every plugin shares one process
 *
 * Isolation between plugins is not the goal here and could not be achieved
 * anyway: plugins are trusted code, the same position VS Code takes. What IS
 * achieved is isolating plugins from *Starbase* — a plugin that hangs or throws
 * takes down this process, not the RPC server every session depends on. Main
 * restarts it and re-activates what was live.
 *
 * ## Why an undeclared command is refused
 *
 * `commands.register` checks the id against the manifest's `contributes.commands`.
 * Without that, a plugin could register anything at import time and the
 * enable/disable switch in Settings would be advisory — the manifest is the
 * contract, and the contract is what the operator is shown.
 */
import { pathToFileURL } from "node:url"
import type {
  ExecReply,
  ExecRequest,
  FromHostMessage,
  HostOp,
  ToHostMessage
} from "@starbase/cli-adapters"
import type {
  AuthSession,
  Disposable,
  HostContext,
  PluginStorage
} from "@starbase/plugin-sdk/host"

/** The parent port, present because this only ever runs as a utilityProcess. */
declare const process: NodeJS.Process & {
  parentPort: {
    on(event: "message", listener: (message: { data: ToHostMessage }) => void): void
    postMessage(message: FromHostMessage): void
  }
}

const send = (message: FromHostMessage): void => process.parentPort.postMessage(message)

// ── Asking main for things ───────────────────────────────────────────────────

let nextRequestId = 0
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

/**
 * Forward one operation to main and await its reply.
 *
 * Rejections carry main's message rather than a generic one: a plugin author
 * debugging "why did my exec fail" needs the reason main actually had.
 */
const ask = <T>(pluginId: string, op: HostOp, payload: unknown): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const requestId = `h${++nextRequestId}`
    pending.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject
    })
    send({ kind: "host-request", requestId, pluginId, op, payload })
  })

// ── Per-plugin state ─────────────────────────────────────────────────────────

interface LivePlugin {
  readonly pluginId: string
  readonly declaredCommands: ReadonlySet<string>
  readonly commands: Map<string, (input?: unknown) => unknown | Promise<unknown>>
  readonly subscriptions: Disposable[]
  readonly deactivate?: () => void | Promise<void>
}

const live = new Map<string, LivePlugin>()

const storageFor = (pluginId: string): PluginStorage => ({
  get: <T,>(key: string) =>
    ask<T | undefined>(pluginId, "storage.get", { key }).then((v) => v ?? undefined),
  set: (key: string, value: unknown) =>
    ask<void>(pluginId, "storage.set", { key, value }),
  delete: (key: string) => ask<void>(pluginId, "storage.delete", { key }),
  keys: () => ask<readonly string[]>(pluginId, "storage.keys", {})
})

const buildContext = (plugin: LivePlugin): HostContext => ({
  pluginId: plugin.pluginId,
  storage: storageFor(plugin.pluginId),
  subscriptions: plugin.subscriptions,

  commands: {
    register: (commandId, handler) => {
      if (!plugin.declaredCommands.has(commandId)) {
        // Refused rather than allowed-with-a-warning: the manifest is what the
        // operator sees in Settings, so a command that exists but is not listed
        // there would be a capability they never agreed to.
        throw new Error(
          `Plugin "${plugin.pluginId}" tried to register the command "${commandId}", which its manifest does not contribute. Add it to contributes.commands.`
        )
      }
      plugin.commands.set(commandId, handler)
      return {
        dispose: () => {
          plugin.commands.delete(commandId)
        }
      }
    }
  },

  events: {
    // Session-lifecycle events are not emitted yet; the subscription is real so
    // a plugin written against it works unchanged when they are, rather than
    // needing to discover a missing method at runtime.
    on: () => ({ dispose: () => {} })
  },

  // Mirrors VS Code: prompting is the default and a declined prompt REJECTS,
  // so the common call site needs no null check. `createIfNone: false` is the
  // opt-in "tell me if there is already a grant" form, which resolves undefined.
  authentication: {
    getSession: ((providerId: string, scopes: readonly string[], opts?: { createIfNone?: boolean }) =>
      ask<AuthSession | undefined>(plugin.pluginId, "auth.getSession", {
        providerId,
        scopes,
        createIfNone: opts?.createIfNone
      })) as HostContext["authentication"]["getSession"],
    registerProvider: () => ({ dispose: () => {} })
  },

  exec: (command, args = [], options = {}) =>
    ask<ExecReply>(plugin.pluginId, "exec", {
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      timeoutMs: options.timeoutMs
    } satisfies ExecRequest),

  log: {
    info: (message: string) =>
      send({ kind: "log", pluginId: plugin.pluginId, level: "info", message }),
    warn: (message: string) =>
      send({ kind: "log", pluginId: plugin.pluginId, level: "warn", message }),
    error: (message: string) =>
      send({ kind: "log", pluginId: plugin.pluginId, level: "error", message })
  }
})

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// ── Message handling ─────────────────────────────────────────────────────────

const activate = async (message: Extract<ToHostMessage, { kind: "activate" }>) => {
  const { requestId, pluginId, entry, declaredCommands } = message

  if (live.has(pluginId)) {
    // Already activated. Idempotent rather than an error: several activation
    // events can fire for one plugin (its tab AND its command), and racing them
    // is normal rather than exceptional.
    send({ kind: "activated", requestId, pluginId })
    return
  }

  const plugin: LivePlugin = {
    pluginId,
    declaredCommands: new Set(declaredCommands),
    commands: new Map(),
    subscriptions: []
  }

  try {
    // `pathToFileURL` because a Windows path is not a valid import specifier —
    // `import("C:\\...")` throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
    const module = (await import(pathToFileURL(entry).href)) as {
      activate?: (ctx: HostContext) => void | Promise<void>
      deactivate?: () => void | Promise<void>
    }

    if (typeof module.activate !== "function") {
      throw new Error(
        `${entry} does not export an \`activate\` function. A plugin's main entry must \`export const activate: Activate = …\`.`
      )
    }

    live.set(pluginId, { ...plugin, deactivate: module.deactivate })
    await module.activate(buildContext(plugin))
    send({ kind: "activated", requestId, pluginId })
  } catch (cause) {
    // Dropped from `live` so a later activation event can try again — a plugin
    // that failed because a file was mid-save should not stay dead until the
    // app restarts.
    live.delete(pluginId)
    send({ kind: "activation-failed", requestId, pluginId, message: messageOf(cause) })
  }
}

const deactivate = async (message: Extract<ToHostMessage, { kind: "deactivate" }>) => {
  const { requestId, pluginId } = message
  const plugin = live.get(pluginId)
  live.delete(pluginId)

  if (plugin) {
    // Reverse order, mirroring VS Code: a subscription registered later may
    // depend on one registered earlier.
    for (const subscription of [...plugin.subscriptions].reverse()) {
      try {
        subscription.dispose()
      } catch (cause) {
        send({
          kind: "log",
          pluginId,
          level: "warn",
          message: `dispose threw during deactivate: ${messageOf(cause)}`
        })
      }
    }
    try {
      await plugin.deactivate?.()
    } catch (cause) {
      send({
        kind: "log",
        pluginId,
        level: "warn",
        message: `deactivate threw: ${messageOf(cause)}`
      })
    }
  }

  send({ kind: "deactivated", requestId, pluginId })
}

const invoke = async (message: Extract<ToHostMessage, { kind: "invoke" }>) => {
  const { requestId, pluginId, commandId, arg } = message
  const handler = live.get(pluginId)?.commands.get(commandId)

  if (!handler) {
    send({
      kind: "invoke-result",
      requestId,
      ok: false,
      message: live.has(pluginId)
        ? `"${commandId}" is not registered. The plugin activated but never called commands.register for it.`
        : `"${pluginId}" is not activated, so "${commandId}" cannot run.`
    })
    return
  }

  try {
    const value = await handler(arg)
    send({ kind: "invoke-result", requestId, ok: true, value })
  } catch (cause) {
    send({ kind: "invoke-result", requestId, ok: false, message: messageOf(cause) })
  }
}

process.parentPort.on("message", ({ data }) => {
  switch (data.kind) {
    case "activate":
      void activate(data)
      break
    case "deactivate":
      void deactivate(data)
      break
    case "invoke":
      void invoke(data)
      break
    case "host-reply": {
      const waiting = pending.get(data.requestId)
      if (!waiting) return
      pending.delete(data.requestId)
      if (data.ok) waiting.resolve(data.value)
      else waiting.reject(new Error(data.message ?? "the host refused the request"))
      break
    }
  }
})

/**
 * An unhandled rejection in plugin code must not take the host down.
 *
 * Node's default is to exit, which would kill every OTHER plugin because one of
 * them forgot a `.catch`. Reported and survived instead — the plugin's own
 * behaviour is already broken, and there is nothing to gain by breaking its
 * neighbours too.
 */
process.on("unhandledRejection", (reason) => {
  send({
    kind: "log",
    pluginId: "<host>",
    level: "error",
    message: `unhandled rejection in a plugin: ${messageOf(reason)}`
  })
})

send({ kind: "ready" })
