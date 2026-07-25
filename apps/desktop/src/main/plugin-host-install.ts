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
  PluginHost,
  PluginHostRuntime,
  type HostProcess,
  type HostRequestHandler
} from "@starbase/cli-adapters"
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
  makeHandler: (deps: {
    storageGet: (pluginId: string, key: string) => Promise<unknown>
    storageSet: (pluginId: string, key: string, value: unknown) => Promise<void>
    storageDelete: (pluginId: string, key: string) => Promise<void>
    storageKeys: (pluginId: string) => Promise<ReadonlyArray<string>>
    defaultCwd: () => string | undefined
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
      // `exec` with no `cwd` runs where the operator is looking. Undefined when
      // no session is active, which spawns in the host's own cwd — deliberately
      // NOT the repos root, since a plugin running a command against a repo it
      // was not told about is a surprise.
      defaultCwd: () => undefined
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
  })
