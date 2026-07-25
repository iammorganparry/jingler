/**
 * The hooks a plugin's UI half calls.
 *
 * ## Why these are declarations, not implementations
 *
 * A plugin does not construct its own bridge to Starbase — it is handed one.
 * The app publishes the real implementations onto a runtime object before React
 * mounts, and the `@starbase/plugin-sdk` specifier in a plugin's bundle resolves
 * (through an importmap) to a generated shim that re-exports off it.
 *
 * So these functions are thin lookups against that runtime. The alternative —
 * having the SDK import Starbase's internals — would make every plugin bundle
 * carry a copy of the app, and would mean a plugin built against one version
 * silently ran against another's data structures.
 *
 * The named error below matters more than it looks: without it, a plugin that
 * somehow loads before the runtime is published fails with
 * `Cannot read properties of undefined`, three frames into someone else's
 * component, with nothing naming Starbase at all.
 */
import type { PluginStorage, SessionSnapshot } from "./common.js"

/** What a plugin's UI half can ask the app for. */
export interface HostBridge {
  /**
   * Run a command registered by this plugin's host half, and get its result.
   *
   * This is the only route from a plugin's UI to anything outside the renderer:
   * the network, a CLI, the filesystem. The renderer's CSP does not allow a
   * plugin to make requests directly, by design.
   *
   * @example
   * ```ts
   * const issues = await useHost().invoke<Issue[]>("linear.sync")
   * ```
   */
  invoke<T = unknown>(commandId: string, arg?: unknown): Promise<T>
  /** This plugin's private key/value store, shared with its host half. */
  readonly storage: PluginStorage
  /** Open a URL in the operator's real browser. */
  openExternal(url: string): Promise<void>
}

interface PluginRuntime {
  readonly bridge: (pluginId: string) => HostBridge
  readonly session: () => SessionSnapshot
  readonly pluginId: () => string
}

const runtime = (): PluginRuntime => {
  const found = (globalThis as { __STARBASE_PLUGIN_API__?: PluginRuntime })
    .__STARBASE_PLUGIN_API__
  if (!found) {
    throw new Error(
      "Starbase plugin API is unavailable. A plugin hook was called outside a plugin view, or before the app finished booting."
    )
  }
  return found
}

/**
 * The bridge to this plugin's host half and its storage.
 *
 * Call inside a view rendered by Starbase — the plugin's identity comes from
 * the surrounding render, so there is nothing to pass in.
 *
 * @example
 * ```ts
 * function IssuesTab({ session }: TabProps) {
 *   const host = useHost()
 *   const [issues, setIssues] = useState<Issue[]>([])
 *   useEffect(() => {
 *     void host.invoke<Issue[]>("linear.sync", { repo: session.repo }).then(setIssues)
 *   }, [host, session.repo])
 *   return <ul>{issues.map((i) => <li key={i.id}>{i.title}</li>)}</ul>
 * }
 * ```
 *
 * @throws If called outside a plugin view.
 */
export function useHost(): HostBridge {
  const api = runtime()
  return api.bridge(api.pluginId())
}

/**
 * The session this tab is decorating.
 *
 * The same value a view receives as `props.session` — useful in a nested
 * component that would otherwise have to thread it down.
 *
 * @example
 * ```ts
 * function Header() {
 *   const session = useSession()
 *   return <h2 className="text-text">{session.repo}</h2>
 * }
 * ```
 */
export function useSession(): SessionSnapshot {
  return runtime().session()
}

/**
 * This plugin's persistent key/value store.
 *
 * Namespaced to the plugin and shared with its host half, so a value written
 * during `activate` is readable here. Survives restarts; the plugin never learns
 * where it lands on disk.
 *
 * @example
 * ```ts
 * const store = usePluginStorage()
 * await store.set("lastSync", new Date().toISOString())
 * ```
 */
export function usePluginStorage(): PluginStorage {
  return useHost().storage
}

/**
 * A bound callable for one of this plugin's host commands.
 *
 * Sugar over {@link useHost}'s `invoke` for the common case of wiring a button
 * to a command.
 *
 * @example
 * ```ts
 * const sync = useCommand<void>("linear.sync")
 * return <button type="button" onClick={() => void sync()}>Sync</button>
 * ```
 */
export function useCommand<T = unknown>(
  commandId: string
): (arg?: unknown) => Promise<T> {
  const host = useHost()
  return (arg?: unknown) => host.invoke<T>(commandId, arg)
}
