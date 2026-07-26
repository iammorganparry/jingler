/**
 * The hooks a plugin's UI half calls.
 *
 * All four resolve through {@link PluginViewContext}, which Starbase provides
 * around every plugin view. See `context.ts` for why that is a context rather
 * than the module-level "current plugin" this originally used — the short
 * version is that a split window renders several plugins at once, and a global
 * would hand every one of them whichever rendered last.
 *
 * The thrown error below is load-bearing. Without it, calling a hook outside a
 * plugin view fails with `Cannot read properties of null`, several frames into
 * someone else's component, naming nothing that would help.
 */
import { useContext, useMemo } from "react"
import type { PluginStorage, SessionSnapshot } from "./common.js"
import { PluginViewContext, type HostBridge, type PluginViewValue } from "./context.js"

const useView = (hook: string): PluginViewValue => {
  const value = useContext(PluginViewContext)
  if (!value) {
    throw new Error(
      `${hook}() was called outside a Starbase plugin view. Plugin hooks only work inside a component rendered by a contributed tab or pane.`
    )
  }
  return value
}

/**
 * The bridge to this plugin's host half and its storage.
 *
 * The plugin's identity comes from the surrounding render, so there is nothing
 * to pass in — and nothing a plugin can pass that would let it reach another
 * plugin's commands or storage.
 *
 * @example
 * ```tsx
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
  return useView("useHost").bridge
}

/**
 * The session this view is decorating.
 *
 * The same value a view receives as `props.session` — useful in a nested
 * component that would otherwise have to thread it down.
 *
 * @example
 * ```tsx
 * function Header() {
 *   const session = useSession()
 *   return <h2 className="text-text">{session.repo}</h2>
 * }
 * ```
 *
 * @throws If called outside a plugin view.
 */
export function useSession(): SessionSnapshot {
  return useView("useSession").session
}

/**
 * This plugin's persistent key/value store.
 *
 * Namespaced to the plugin and shared with its host half, so a value written
 * during `activate` is readable here. Survives restarts, and the plugin never
 * learns where it lands on disk.
 *
 * That namespacing is bookkeeping, NOT a security boundary. Every plugin's host
 * half shares one Node process, so a plugin determined to read another's keys
 * can — see `docs/plugins/permissions-and-trust.md`. It keeps honest plugins
 * from colliding; it does not contain a dishonest one.
 *
 * @example
 * ```ts
 * const store = usePluginStorage()
 * await store.set("lastSync", new Date().toISOString())
 * const last = await store.get<string>("lastSync")
 * ```
 *
 * @throws If called outside a plugin view.
 */
export function usePluginStorage(): PluginStorage {
  return useView("usePluginStorage").bridge.storage
}

/**
 * A bound callable for one of this plugin's host commands.
 *
 * Sugar over {@link useHost}'s `invoke` for the common case of wiring a control
 * to a command. The returned function is referentially stable for a given
 * command id, so it is safe in a dependency array.
 *
 * @example
 * ```tsx
 * const sync = useCommand<void>("linear.sync")
 * return <button type="button" onClick={() => void sync()}>Sync</button>
 * ```
 *
 * @throws If called outside a plugin view.
 */
export function useCommand<T = unknown>(
  commandId: string
): (arg?: unknown) => Promise<T> {
  const { bridge } = useView("useCommand")
  return useMemo(
    () => (arg?: unknown) => bridge.invoke<T>(commandId, arg),
    [bridge, commandId]
  )
}
