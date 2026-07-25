/**
 * The live plugin set, as React context.
 *
 * Owns one job: keep `~/starbase/plugins` on disk and the app's contributions in
 * sync, in both directions of change — a plugin added, edited, enabled, disabled
 * or removed. It subscribes to `Plugins.watch`, which re-emits the WHOLE catalog
 * on every change rather than a delta, so this file never accumulates state that
 * could drift out of step with disk.
 *
 * ## Why loading is keyed by id AND version
 *
 * ES module imports are cached by URL for the life of the realm. Re-importing an
 * edited plugin at the same URL returns the original module, so the author saves
 * a file and watches nothing happen. `pluginModuleUrl` puts the manifest version
 * in the query string and this file re-imports whenever that key changes — which
 * is why bumping `version` is the documented way to force a reload.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react"
import type { PluginCatalog } from "@starbase/core"
import type { TabContribution } from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import {
  loadPlugins,
  type ActivePlugin,
  type PluginLoadError
} from "./plugin-loader.js"
import { PluginTabHost } from "./plugin-tab-host.js"

interface PluginRegistryValue {
  /** Tabs contributed by every enabled plugin that loaded, ready to merge. */
  readonly tabs: ReadonlyArray<TabContribution>
  /** Plugins that failed to load, for Settings to show verbatim. */
  readonly errors: ReadonlyArray<PluginLoadError>
  /** The last catalog from disk, including manifests that failed to decode. */
  readonly catalog: PluginCatalog | null
}

const EMPTY: PluginRegistryValue = { tabs: [], errors: [], catalog: null }

const PluginRegistryContext = createContext<PluginRegistryValue>(EMPTY)

/** One stable key per loaded plugin set — see the note on versions above. */
const catalogKey = (catalog: PluginCatalog | null): string =>
  (catalog?.plugins ?? [])
    .filter((p) => p.enabled)
    .map((p) => `${p.manifest.id}@${p.manifest.version}`)
    .join(",")

export function PluginProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [loaded, setLoaded] = useState<{
    active: ReadonlyArray<ActivePlugin>
    errors: ReadonlyArray<PluginLoadError>
  }>({ active: [], errors: [] })

  // One read at mount, then live updates. The initial read matters: `watch`
  // only emits on CHANGE, so without it the app would show no plugins until the
  // operator happened to touch the directory.
  useEffect(() => {
    let cancelled = false
    void rpc
      .pluginsList()
      .then((next) => {
        if (!cancelled) setCatalog(next)
      })
      // A failure here means no plugins, not a broken app. The operator sees an
      // empty list, which is also what "none installed" looks like — acceptable,
      // because the alternative is a modal about a subsystem they never used.
      .catch(() => {
        if (!cancelled) setCatalog({ plugins: [], failed: [] })
      })

    const unsubscribe = rpc.pluginsWatch((next) => {
      if (!cancelled) setCatalog(next)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const key = catalogKey(catalog)

  useEffect(() => {
    if (!catalog) return
    let cancelled = false
    void loadPlugins(catalog.plugins).then((next) => {
      if (!cancelled) setLoaded(next)
    })
    return () => {
      cancelled = true
    }
    // Keyed by id@version rather than by `catalog` identity: a watch re-emit
    // that changed nothing relevant (a disabled plugin's mtime, say) must not
    // re-import every module and remount every plugin tab under the operator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const value = useMemo<PluginRegistryValue>(() => {
    const tabs = loaded.active.flatMap((plugin) =>
      plugin.tabs.map((tab) => ({
        ...tab,
        // Every plugin body is wrapped HERE rather than in the loader, so the
        // boundary is guaranteed present no matter who built the contribution.
        render: (session: Parameters<typeof tab.render>[0], ctx: Parameters<typeof tab.render>[1]) => (
          <PluginTabHost pluginId={plugin.id}>{tab.render(session, ctx)}</PluginTabHost>
        )
      }))
    )
    return {
      tabs,
      // Manifests that never decoded are failures too, and the operator should
      // see them in the same list as modules that failed to import.
      errors: [
        ...loaded.errors,
        ...(catalog?.failed ?? []).map((f) => ({ id: f.dir, message: f.message }))
      ],
      catalog
    }
  }, [loaded, catalog])

  return (
    <PluginRegistryContext.Provider value={value}>
      {children}
    </PluginRegistryContext.Provider>
  )
}

/** Every plugin-contributed tab, ready to hand to `SessionPane`. */
export const usePluginTabs = (): ReadonlyArray<TabContribution> =>
  useContext(PluginRegistryContext).tabs

/** Plugins that failed to load — manifest or module — for Settings. */
export const usePluginErrors = (): ReadonlyArray<PluginLoadError> =>
  useContext(PluginRegistryContext).errors

/** The raw catalog, for the Settings list. */
export const usePluginCatalog = (): PluginCatalog | null =>
  useContext(PluginRegistryContext).catalog
