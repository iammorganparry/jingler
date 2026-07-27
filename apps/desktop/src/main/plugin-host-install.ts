/**
 * Handing the plugin host its Electron-shaped pieces at startup.
 *
 * `PluginHostRuntime` is constructed here rather than inside its own layer for
 * one reason: it needs `utilityProcess` and the filesystem, and the whole point
 * of keeping `cli-adapters` free of Electron is that its crash and restart paths
 * stay testable without spawning anything. So the service holds a slot, and this
 * is what fills it.
 *
 * Nothing is spawned by this call. The first activation event starts the
 * process — which is the entire point of lazy activation, and is why installing
 * the host costs nothing on a launch where the operator never opens a plugin.
 */
import { Effect } from "effect"
import {
  makeGithubAuthProvider,
  PluginAuth,
  PluginRegistry,
  PluginHost,
  PluginHostRuntime,
  type ConsentPrompt,
  type HostProcess,
  type HostRequestHandler
} from "@jingler/cli-adapters"
import { pluginStorageDelete, pluginStorageGet, pluginStorageKeys, pluginStorageSet } from "./rpc.js"
import { runtime as appRuntime } from "./runtime.js"

/**
 * Build the runtime and install it.
 *
 * The factories are parameters rather than imports so that this module does not
 * pull Electron into anything that merely wants the wiring — and so a test can
 * install a fake pair without a window.
 */
export const installPluginHost = (
  spawn: () => HostProcess,
  consentPrompt: ConsentPrompt,
  makeHandler: (deps: {
    storageGet: (pluginId: string, key: string) => Promise<unknown>
    storageSet: (pluginId: string, key: string, value: unknown) => Promise<void>
    storageDelete: (pluginId: string, key: string) => Promise<void>
    storageKeys: (pluginId: string) => Promise<ReadonlyArray<string>>
    defaultCwd: () => string | undefined
    getSession: (
      pluginId: string,
      request: { providerId: string; scopes: readonly string[]; createIfNone?: boolean }
    ) => Promise<{ accessToken: string; account?: string; scopes: readonly string[] } | null>
  }) => HostRequestHandler
) =>
  Effect.gen(function* () {
    // Storage is served by the same code the renderer's `Plugins.storage*`
    // handlers use, so a value written by a plugin's host half is the same value
    // its UI half reads. Two implementations would be two answers.
    const handler = makeHandler({
      storageGet: (pluginId, key) => appRuntime.runPromise(pluginStorageGet(pluginId, key)),
      storageSet: (pluginId, key, value) =>
        appRuntime.runPromise(pluginStorageSet(pluginId, key, value)),
      storageDelete: (pluginId, key) =>
        appRuntime.runPromise(pluginStorageDelete(pluginId, key)),
      storageKeys: (pluginId) => appRuntime.runPromise(pluginStorageKeys(pluginId)),
      // No default. `exec` with no `cwd` runs in the host process's own
      // directory, and the SDK now says so.
      //
      // `ExecOptions` used to promise "the active session's worktree" while this
      // returned undefined — so `ctx.exec("git", ["status"])` written straight
      // from the docs ran wherever Electron happened to be. Read-only that is
      // merely wrong; a mutating git command in the wrong directory is
      // destructive.
      //
      // Fixed by correcting the contract rather than inventing a default. Main
      // has no notion of a focused session — that is renderer state — and the
      // plugin already holds the right answer: `session.worktreePath` is on the
      // snapshot its tab was handed. Guessing on its behalf would pick the wrong
      // repo the moment a split has two sessions open.
      defaultCwd: () => undefined,
      getSession: (pluginId, request) =>
        appRuntime.runPromise(
          Effect.gen(function* () {
            const catalog = yield* PluginRegistry.list()
            const plugin = catalog.plugins.find((p) => p.manifest.id === pluginId)
            return yield* PluginAuth.getSession({
              pluginId,
              // The prompt shows the plugin's display name, not its id — the
              // operator picked it by name in Settings.
              pluginName: plugin?.manifest.name ?? pluginId,
              providerId: request.providerId,
              scopes: request.scopes,
              createIfNone: request.createIfNone
            })
          })
        )
    })

    const hostRuntime = new PluginHostRuntime(spawn, handler, {
      onActivationFailed: (pluginId, message) => {
        console.error(`[plugin:${pluginId}] activation failed: ${message}`)
      },
      onLog: (pluginId, level, message) => {
        const line = `[plugin:${pluginId}] ${message}`
        if (level === "error") console.error(line)
        else if (level === "warn") console.warn(line)
        else console.info(line)
      }
    })

    yield* PluginHost.install(hostRuntime)

    // The consent prompt is main's to supply: it owns the window, and the prompt
    // is deliberately a NATIVE modal so plugin code in the renderer cannot
    // obscure or mimic the one decision that is purely about trust.
    yield* PluginAuth.setPrompt(consentPrompt)

    // GitHub is registered as an ORDINARY provider, not a shortcut. That is what
    // makes the claim in the docs true: the official GitHub plugin holds no
    // privilege a third-party one could not also request.
    yield* PluginAuth.registerProvider(
      makeGithubAuthProvider((effect) => appRuntime.runPromise(effect))
    )

    yield* dispatchStartupActivations(hostRuntime)
  })

/**
 * Fire `onStartupFinished` for every enabled plugin that declares it.
 *
 * Nothing fired it before, so this was the one activation event that could not
 * happen at all: `activate()` was reachable only through `invoke()`, which needs a
 * command call, which needs UI. A plugin whose entire purpose is to subscribe to
 * session events in `activate` — a legitimate and documented shape — never ran a
 * line of code.
 *
 * ## Why here rather than in the renderer
 *
 * "Startup finished" is a property of the app, not of a window, and main is the
 * only place that knows the difference. Dispatching from the renderer would fire
 * it again on every reload of the renderer, which is not what the name promises.
 *
 * ## Why failures are logged and swallowed
 *
 * This runs during boot. A plugin whose `activate` throws must not take the app
 * down with it, and there is no operator watching a modal at this moment — the
 * failure belongs in the log and in Settings, which is where
 * `onActivationFailed` already puts it. Every activation is independent for the
 * same reason: one bad plugin must not stop the next one starting.
 */
const dispatchStartupActivations = (host: PluginHostRuntime) =>
  Effect.gen(function* () {
    const catalog = yield* PluginRegistry.list().pipe(
      Effect.catchAll(() => Effect.succeed(null))
    )
    if (catalog === null) return

    const wanted = catalog.plugins.filter(
      (p) =>
        p.enabled &&
        p.manifest.main !== undefined &&
        (p.manifest.activationEvents ?? []).includes("onStartupFinished")
    )
    if (wanted.length === 0) return

    yield* Effect.forEach(
      wanted,
      (plugin) =>
        Effect.promise(() =>
          host.activate(plugin).catch((cause: unknown) => {
            console.error(
              `[plugin:${plugin.manifest.id}] onStartupFinished activation failed:`,
              cause
            )
          })
        ),
      { concurrency: "unbounded", discard: true }
    )
  })
